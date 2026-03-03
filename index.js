/* ============================================================
   Prompt Folders & Search — SillyTavern Extension
   ============================================================ */
(function () {
    'use strict';

    const MODULE_NAME = 'prompt_folders_search';
    const POLL_MS = 800;

    /* ─── 상태 (State) ─── */
    let lastPreset = '';
    let observer = null;
    let pollTimer = null;
    let isRebuilding = false;
    let searchQuery = '';
    let searchHasFocus = false;
    let dirty = false;
    let isImporting = false;
    let needsSTSync = false; // 유저가 폴더를 직접 다시 정렬할 때만 참(true)이 됩니다.

    /* ─── 설정 도우미 (Settings helpers) ─── */
    function ctx() { return SillyTavern.getContext(); }

    // 작업용 데이터 사본 (Working copy) — 여기서 변경된 내용은 저장 전까지 extensionSettings에 반영되지 않습니다.
    let workingData = null;  // { folders: [], assignments: {} }
    let workingPreset = '';

    function ensureStorageExists() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = { presets: {} };
    }

    function getCurrentPresetName() {
        const sel = document.getElementById('settings_preset_openai');
        if (sel) {
            const opt = sel.options[sel.selectedIndex];
            if (opt) return opt.textContent.trim() || opt.value;
        }
        return '__default__';
    }

    // extensionSettings에서 작업 사본으로 가져오기
    function loadWorkingData(isFirstLoad = false) {
        ensureStorageExists();
        const p = getCurrentPresetName();
        const { extensionSettings } = ctx();
        const session = extensionSettings[MODULE_NAME].sessionState;

        if (isFirstLoad) {
            // F5 새로고침 또는 처음 시작: 현재 프리셋과 일치하면 세션 상태 복구
            if (session && session.preset === p && session.data) {
                workingData = JSON.parse(JSON.stringify(session.data));
            } else {
                const saved = extensionSettings[MODULE_NAME].presets[p];
                workingData = saved ? JSON.parse(JSON.stringify(saved)) : { folders: [], assignments: {} };
            }
        } else {
            // 세션 도중 프리셋 변경: 기존 세션 상태를 버리고 저장된 프리셋에서 깨끗하게 다시 불러오기
            const saved = extensionSettings[MODULE_NAME].presets[p];
            workingData = saved ? JSON.parse(JSON.stringify(saved)) : { folders: [], assignments: {} };
            // 변경된 불러오기 상태를 세션 상태에 반영
            extensionSettings[MODULE_NAME].sessionState = { preset: p, data: JSON.parse(JSON.stringify(workingData)) };
            ctx().saveSettingsDebounced();
        }

        workingPreset = p;
        dirty = false;
    }

    // 작업 사본 가져오기 (이름이 변경된 경우 자동 불러오기)
    function getPresetData() {
        const p = getCurrentPresetName();
        if (!workingData || workingPreset !== p) loadWorkingData(lastPreset === '');
        return workingData;
    }

    function markDirty() {
        dirty = true;
        // F5를 눌러도 상태가 유지되도록, 실제 프리셋 파일을 덮어쓰지 않고 sessionState에만 자동 저장합니다
        const { extensionSettings } = ctx();
        extensionSettings[MODULE_NAME].sessionState = { preset: workingPreset, data: JSON.parse(JSON.stringify(workingData)) };
        ctx().saveSettingsDebounced();
    }

    // 작업 사본을 extensionSettings의 실제 프리셋으로 작성 (프리셋 업데이트를 클릭했을 때만 실행)
    function persistNow() {
        ensureStorageExists();
        const { extensionSettings } = ctx();
        extensionSettings[MODULE_NAME].presets[workingPreset] = JSON.parse(JSON.stringify(workingData));
        extensionSettings[MODULE_NAME].sessionState = { preset: workingPreset, data: JSON.parse(JSON.stringify(workingData)) };
        ctx().saveSettingsDebounced();
        dirty = false;
        console.log('[PF] saved to preset:', workingPreset);
    }

    function hookSaveButton() {
        const btn = document.getElementById('update_oai_preset');
        if (!btn) { setTimeout(hookSaveButton, 2000); return; }
        if (btn._pfHooked) return;
        btn._pfHooked = true;
        btn.addEventListener('click', () => { if (dirty) persistNow(); });
    }

    /* ─── Folder CRUD ─── */
    function addFolder(name) {
        const d = getPresetData();
        const id = 'pf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        d.folders.push({ id, name, collapsed: false, order: d.folders.length, bgColor: '', textColor: '' });
        markDirty(); rebuildFolderUI();
        return id;
    }

    function deleteFolder(folderId) {
        const d = getPresetData();
        d.folders = d.folders.filter(f => f.id !== folderId);
        for (const [k, v] of Object.entries(d.assignments)) { if (v === folderId) delete d.assignments[k]; }
        markDirty(); rebuildFolderUI();
    }

    function renameFolder(folderId, newName) {
        const d = getPresetData();
        const f = d.folders.find(f => f.id === folderId);
        if (f) { f.name = newName; markDirty(); }
    }

    function setFolderColor(folderId, bgColor, textColor) {
        const d = getPresetData();
        const f = d.folders.find(f => f.id === folderId);
        if (f) { f.bgColor = bgColor || ''; f.textColor = textColor || ''; markDirty(); rebuildFolderUI(); }
    }

    function toggleCollapse(folderId) {
        const d = getPresetData();
        const f = d.folders.find(f => f.id === folderId);
        if (f) { f.collapsed = !f.collapsed; markDirty(); }
    }

    function moveFolderUp(folderId) {
        const d = getPresetData();
        const sorted = [...d.folders].sort((a, b) => a.order - b.order);
        const idx = sorted.findIndex(f => f.id === folderId);
        if (idx <= 0) return;
        // 제거 후 한 칸 위로 삽입
        sorted.splice(idx, 1);
        sorted.splice(idx - 1, 0, d.folders.find(f => f.id === folderId));
        sorted.forEach((f, i) => f.order = i);
        markDirty(); needsSTSync = true; rebuildFolderUI();
    }

    function moveFolderDown(folderId) {
        const d = getPresetData();
        const sorted = [...d.folders].sort((a, b) => a.order - b.order);
        const idx = sorted.findIndex(f => f.id === folderId);
        if (idx < 0 || idx >= sorted.length - 1) return;
        // 제거 후 한 칸 아래로 삽입
        sorted.splice(idx, 1);
        sorted.splice(idx + 1, 0, d.folders.find(f => f.id === folderId));
        sorted.forEach((f, i) => f.order = i);
        markDirty(); needsSTSync = true; rebuildFolderUI();
    }

    function assignPrompt(identifier, folderId) {
        const d = getPresetData();
        if (folderId) d.assignments[identifier] = folderId;
        else delete d.assignments[identifier];
        markDirty(); rebuildFolderUI();
    }

    /* ─── DOM 도우미 ─── */
    function getListContainer() {
        return document.getElementById('completion_prompt_manager_list') || document.querySelector('.completion_prompt_manager_list');
    }
    function getPromptRows(c) { return c ? Array.from(c.querySelectorAll('[data-pm-identifier]')) : []; }
    function getPromptName(row) {
        const el = row.querySelector('.prompt_manager_prompt_name, .completion_prompt_manager_prompt_name, [data-pm-name]');
        return el ? el.textContent.trim() : (row.getAttribute('data-pm-identifier') || '?');
    }

    /* ─── 모달 오버레이 ─── */
    function createModalOverlay(innerEl) {
        document.querySelectorAll('.pf-overlay').forEach(el => el.remove());
        const overlay = document.createElement('div');
        overlay.className = 'pf-overlay';
        overlay.appendChild(innerEl);

        // 모달 클릭 시 ST의 외부 클릭 방지(패널 닫힘) 우회하기 (모바일 터치 이벤트 포함)
        const stopProp = (e) => e.stopPropagation();
        const startHandler = (e) => {
            e.stopPropagation();
            if (e.target === overlay) {
                // 이벤트 타겟이 떨어진 후 bubbling되는 것을 막기 위해 살짝 지연해서 없앱니다.
                setTimeout(() => overlay.remove(), 0);
            }
        };

        overlay.addEventListener('mousedown', startHandler);
        overlay.addEventListener('touchstart', startHandler, { passive: false });
        overlay.addEventListener('mouseup', stopProp);
        overlay.addEventListener('touchend', stopProp);
        overlay.addEventListener('touchcancel', stopProp);
        overlay.addEventListener('click', stopProp);

        document.body.appendChild(overlay);
        return overlay;
    }

    /* ─── UI 생성 (Build UI) ─── */
    function rebuildFolderUI() {
        if (isRebuilding) return;
        isRebuilding = true;
        const list = getListContainer();
        if (!list) { isRebuilding = false; return; }

        const si = list.querySelector('.pf-search-input');
        searchHasFocus = si && (document.activeElement === si);
        const cursorPos = searchHasFocus ? si.selectionStart : -1;

        _doRebuild(list);
        syncPromptOrder(list);
        isRebuilding = false;

        if (searchHasFocus) {
            const ns = list.querySelector('.pf-search-input');
            if (ns) { ns.focus(); if (cursorPos >= 0) ns.setSelectionRange(cursorPos, cursorPos); }
        }
    }

    /* ─── DOM 재정렬 후 ST 내부 데이터에 프롬프트 순서 동기화 ─── */
    function getServiceSettings() {
        // prompt_order가 있는 OpenAI/service 설정을 찾기 위해 여러 경로 탐색
        try {
            const context = ctx();
            // 경로 1: context.promptManager
            if (context.promptManager && context.promptManager.serviceSettings) {
                return context.promptManager.serviceSettings;
            }
            // 경로 2: oai_settings 전역
            if (window.oai_settings) {
                return window.oai_settings;
            }
            // 경로 3: context.openai_settings
            if (context.openai_settings) {
                return context.openai_settings;
            }
            // 경로 4: context 내부 객체 중 prompt_order를 가진 객체 찾기
            for (const key of Object.keys(context)) {
                const val = context[key];
                if (val && typeof val === 'object' && !Array.isArray(val) && 'prompt_order' in val) {
                    console.log('[PF] found prompt_order in context.' + key);
                    return val;
                }
            }
            console.warn('[PF] could not find serviceSettings. Context keys:', Object.keys(context).join(', '));
        } catch (e) {
            console.warn('[PF] getServiceSettings error:', e);
        }
        return null;
    }

    function syncPromptOrder(list) {
        try {
            const rows = getPromptRows(list);
            const orderedIds = rows
                .filter(r => r.style.display !== 'none' || true)
                .map(r => r.getAttribute('data-pm-identifier'))
                .filter(Boolean);
            if (!orderedIds.length) return;

            const d = getPresetData();
            let extensionOrderChanged = false;
            if (!d.promptOrder || d.promptOrder.join(',') !== orderedIds.join(',')) {
                d.promptOrder = orderedIds;
                markDirty();
                extensionOrderChanged = true;
            }

            // ★ 유저가 폴더를 수동으로 정렬했을 때만 ST 내부 데이터 수정
            if (needsSTSync && !isImporting) {
                const ss = getServiceSettings();
                if (ss) {
                    // prompts 배열 재정렬
                    if (ss.prompts) {
                        const prompts = ss.prompts;
                        const promptMap = {};
                        prompts.forEach(p => { promptMap[p.identifier] = p; });

                        const reordered = [];
                        const used = new Set();
                        for (const id of orderedIds) {
                            if (promptMap[id]) { reordered.push(promptMap[id]); used.add(id); }
                        }
                        for (const p of prompts) {
                            if (!used.has(p.identifier)) reordered.push(p);
                        }

                        let changed = false;
                        for (let i = 0; i < prompts.length; i++) {
                            if (prompts[i]?.identifier !== reordered[i]?.identifier) { changed = true; break; }
                        }

                        if (changed) {
                            prompts.length = 0;
                            reordered.forEach(p => prompts.push(p));
                            console.log('[PF] prompts array reordered');
                        }
                    }

                    // 메모리의 prompt_order 재정렬
                    if (ss.prompt_order) {
                        reorderPromptOrderEntries(ss, orderedIds);
                    }
                }
                needsSTSync = false;
            }
        } catch (e) {
            console.warn('[PF] syncPromptOrder error:', e);
        }
    }

    /* ─── ST의 prompt_order 항목을 폴더 순서에 맞게 재정렬 ─── */
    function reorderPromptOrderEntries(ss, orderedIds) {
        try {
            if (!ss || !ss.prompt_order) {
                console.warn('[PF] prompt_order not found');
                return false;
            }
            const promptOrder = ss.prompt_order;
            if (!Array.isArray(promptOrder) || promptOrder.length === 0) {
                console.warn('[PF] prompt_order is empty or not array');
                return false;
            }

            console.log('[PF] prompt_order entries:', promptOrder.length,
                'structure:', JSON.stringify(promptOrder.map(e => ({
                    character_id: e.character_id,
                    orderLen: e.order ? e.order.length : 0
                }))));

            let anyChanged = false;
            const firstEntry = promptOrder[0];

            if (firstEntry && typeof firstEntry === 'object' && 'order' in firstEntry) {
                // 중첩된 구조: [{character_id, order: [...]}]
                for (const entry of promptOrder) {
                    if (entry && Array.isArray(entry.order)) {
                        const before = entry.order.map(e => e.identifier).join(',');
                        reorderFlatOrderArray(entry.order, orderedIds);
                        const after = entry.order.map(e => e.identifier).join(',');
                        if (before !== after) {
                            anyChanged = true;
                            console.log(`[PF] character_id ${entry.character_id} order changed`);
                        }
                    }
                }
            } else if (firstEntry && typeof firstEntry === 'object' && 'identifier' in firstEntry) {
                // 평탄한 구조: [{identifier, enabled}]
                const before = promptOrder.map(e => e.identifier).join(',');
                reorderFlatOrderArray(promptOrder, orderedIds);
                const after = promptOrder.map(e => e.identifier).join(',');
                if (before !== after) anyChanged = true;
            }

            if (anyChanged) {
                console.log('[PF] prompt_order reordered successfully');
            } else {
                console.log('[PF] prompt_order: no change needed');
            }
            return anyChanged;
        } catch (e) {
            console.warn('[PF] reorderPromptOrderEntries error:', e);
            return false;
        }
    }

    function reorderFlatOrderArray(orderArr, orderedIds) {
        if (!Array.isArray(orderArr) || orderArr.length === 0) return;
        const entryMap = {};
        orderArr.forEach(e => { if (e && e.identifier) entryMap[e.identifier] = e; });

        const reordered = [];
        const used = new Set();
        for (const id of orderedIds) {
            if (entryMap[id]) { reordered.push(entryMap[id]); used.add(id); }
        }
        // orderedIds에 없는 나머지 항목들 이어붙이기
        for (const e of orderArr) {
            if (e && e.identifier && !used.has(e.identifier)) reordered.push(e);
            else if (e && !e.identifier) reordered.push(e); // 식별자 없는 항목 유지
        }

        // 제자리 교체 (Replace in-place)
        orderArr.length = 0;
        reordered.forEach(e => orderArr.push(e));
    }

    function _doRebuild(list) {
        const d = getPresetData();
        const rows = getPromptRows(list);
        if (rows.length === 0) return;

        list.querySelectorAll('.pf-injected:not(.pf-toolbar)').forEach(el => el.remove());
        list.querySelectorAll('.pf-folder-btn').forEach(el => el.remove());

        const firstRow = rows[0];
        const parent = firstRow.parentElement;

        let toolbar = list.querySelector('.pf-toolbar');
        if (!toolbar) toolbar = createToolbar();
        // 아직 상단에 없을 때만 상단으로 이동시킵니다 (포커스 잃음 방지)
        if (toolbar.parentElement !== list || toolbar !== list.firstChild) {
            list.insertBefore(toolbar, list.firstChild);
        }

        const assignedRows = {};
        const unassignedRows = [];

        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const fId = d.assignments[id];
            if (fId && d.folders.some(f => f.id === fId)) {
                if (!assignedRows[fId]) assignedRows[fId] = [];
                assignedRows[fId].push(row);
            } else {
                unassignedRows.push(row);
            }
            addFolderButton(row, id);
        }

        for (const folder of [...d.folders].sort((a, b) => a.order - b.order)) {
            parent.appendChild(createFolderHeader(folder));
            for (const row of (assignedRows[folder.id] || [])) {
                row.classList.add('pf-folder-item');
                row.setAttribute('data-pf-folder', folder.id);
                parent.appendChild(row);
                row.style.display = (folder.collapsed && !searchQuery) ? 'none' : '';
            }
        }

        if (unassignedRows.length > 0) {
            parent.appendChild(createUncategorizedHeader());
            for (const row of unassignedRows) {
                row.classList.remove('pf-folder-item');
                row.removeAttribute('data-pf-folder');
                row.style.display = '';
                parent.appendChild(row);
            }
        }

        if (searchQuery) applySearchFilter(rows);
    }

    /* ─── 도구 모음 (Toolbar) ─── */
    function createToolbar() {
        const wrap = document.createElement('div');
        wrap.className = 'pf-toolbar pf-injected';

        const sw = document.createElement('div');
        sw.className = 'pf-search-wrap';
        const si = document.createElement('input');
        si.type = 'text'; si.className = 'pf-search-input text_pole';
        si.placeholder = '🔍 프롬프트 검색…'; si.value = searchQuery;
        let st = null;
        si.addEventListener('input', (e) => { searchQuery = e.target.value.toLowerCase(); clearTimeout(st); st = setTimeout(() => rebuildFolderUI(), 200); });
        si.addEventListener('focus', () => { searchHasFocus = true; });
        si.addEventListener('blur', () => { searchHasFocus = false; });
        sw.appendChild(si);

        const bw = document.createElement('div');
        bw.className = 'pf-btn-wrap';
        [
            mkBtn('📁 추가', () => showAddFolderPopup()),
            mkBtn('⬆ 접기', () => { getPresetData().folders.forEach(f => f.collapsed = true); markDirty(); rebuildFolderUI(); }),
            mkBtn('⬇ 펼치기', () => { getPresetData().folders.forEach(f => f.collapsed = false); markDirty(); rebuildFolderUI(); }),
            mkBtn('🔨 편집', () => showBulkEditPopup()),
            mkBtn('📥', () => showImportSettingsPopup()),
        ].forEach(b => bw.appendChild(b));

        wrap.appendChild(sw);
        wrap.appendChild(bw);
        return wrap;
    }

    function mkBtn(text, fn) {
        const b = document.createElement('button');
        b.className = 'pf-btn menu_button'; b.textContent = text;
        b.addEventListener('click', fn); return b;
    }

    /* ─── 폴더 헤더 ─── */
    function createFolderHeader(folder) {
        const header = document.createElement('div');
        header.className = 'pf-folder-header pf-injected';
        header.setAttribute('data-pf-folder-id', folder.id);
        if (folder.bgColor) header.style.backgroundColor = folder.bgColor;
        if (folder.textColor) header.style.color = folder.textColor;

        const arrow = document.createElement('span');
        arrow.className = 'pf-arrow';
        arrow.textContent = folder.collapsed ? '▶' : '▼';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'pf-folder-name';
        nameSpan.textContent = folder.name;

        const d = getPresetData();
        const promptIds = Object.entries(d.assignments).filter(([, v]) => v === folder.id).map(([k]) => k);
        const total = promptIds.length;
        const list = getListContainer();
        let active = 0;
        if (list) {
            for (const pid of promptIds) {
                const row = list.querySelector(`[data-pm-identifier="${pid}"]`);
                if (!row) continue;
                const toggle = row.querySelector('input[type="checkbox"]');
                if (toggle && toggle.checked) { active++; continue; }
                if (row.querySelector('.fa-toggle-on, .toggle-on')) { active++; }
            }
        }
        const countSpan = document.createElement('span');
        countSpan.className = 'pf-count';
        countSpan.textContent = `(${active}/${total})`;
        countSpan.title = `${active}개 활성화 / ${total}개 전체`;

        // ⚡ 토글
        const toggleBtn = document.createElement('span');
        toggleBtn.className = 'pf-action-btn-always';
        toggleBtn.textContent = '⚡';
        toggleBtn.title = '폴더 전체 토글';
        toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleAllPromptsInFolder(folder.id); });

        // ▲▼ 이동
        const upBtn = document.createElement('span');
        upBtn.className = 'pf-action-btn-always';
        upBtn.textContent = '▲';
        upBtn.title = '위로 이동';
        upBtn.addEventListener('click', (e) => { e.stopPropagation(); moveFolderUp(folder.id); });

        const downBtn = document.createElement('span');
        downBtn.className = 'pf-action-btn-always';
        downBtn.textContent = '▼';
        downBtn.title = '아래로 이동';
        downBtn.addEventListener('click', (e) => { e.stopPropagation(); moveFolderDown(folder.id); });

        // ✏️ 편집 (삭제도 여기 안에)
        const editBtn = document.createElement('span');
        editBtn.className = 'pf-action-btn-always';
        editBtn.textContent = '✏️';
        editBtn.title = '편집';
        editBtn.addEventListener('click', (e) => { e.stopPropagation(); showFolderEditPopup(folder); });

        [arrow, nameSpan, countSpan, toggleBtn, upBtn, downBtn, editBtn].forEach(el => header.appendChild(el));

        // 클릭 → 접기/펼치기
        header.addEventListener('click', () => { toggleCollapse(folder.id); rebuildFolderUI(); });

        // ★ 폴더 DnD 기능 (드래그 앤 드롭)
        header.setAttribute('draggable', 'true');
        header.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            e.dataTransfer.setData('text/pf-folder-id', folder.id);
            e.dataTransfer.effectAllowed = 'move';
            header.classList.add('pf-dragging');
        });
        header.addEventListener('dragend', () => {
            header.classList.remove('pf-dragging');
            document.querySelectorAll('.pf-drag-over-top, .pf-drag-over-bottom').forEach(el => {
                el.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom');
            });
        });
        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.dataTransfer.types.includes('text/pf-folder-id')) return;
            e.dataTransfer.dropEffect = 'move';
            // 마우스 위치에 따라 위쪽 혹은 아래쪽 표시기 표시
            const rect = header.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            header.classList.toggle('pf-drag-over-top', e.clientY < midY);
            header.classList.toggle('pf-drag-over-bottom', e.clientY >= midY);
        });
        header.addEventListener('dragleave', () => {
            header.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom');
        });
        header.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = header.getBoundingClientRect();
            const before = e.clientY < rect.top + rect.height / 2;
            header.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom');
            const srcFolderId = e.dataTransfer.getData('text/pf-folder-id');
            if (srcFolderId && srcFolderId !== folder.id) {
                moveFolderToPosition(srcFolderId, folder.id, before);
            }
        });

        return header;
    }

    /* ─── 폴더 편집 팝업 ─── */
    function showFolderEditPopup(folder) {
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        inner.innerHTML = `
            <div class="pf-popup-title" style="display:flex;align-items:center;justify-content:center;gap:8px">✏️ 폴더 편집<button class="pf-btn menu_button pf-delete-folder" style="color:#ff6b6b;font-size:11px;padding:2px 6px!important;margin-left:auto">🗑️ 삭제</button></div>
            <div class="pf-popup-field"><label>이름:</label><input type="text" class="pf-edit-name text_pole" value="${folder.name}"></div>
            <div class="pf-color-row"><label>배경색:</label><input type="color" class="pf-cbg" value="${folder.bgColor || '#3a3a3a'}"><input type="text" class="pf-cbg-hex text_pole" placeholder="(UI 설정 따름)" value="${folder.bgColor || ''}"><button class="pf-btn menu_button pf-reset-bg" style="font-size:11px;padding:2px 6px!important" title="UI 설정 사용">↺</button></div>
            <div class="pf-color-row"><label>글자색:</label><input type="color" class="pf-ctx" value="${folder.textColor || '#cccccc'}"><input type="text" class="pf-ctx-hex text_pole" placeholder="(UI 설정 따름)" value="${folder.textColor || ''}"><button class="pf-btn menu_button pf-reset-tx" style="font-size:11px;padding:2px 6px!important" title="UI 설정 사용">↺</button></div>
            <div class="pf-popup-actions">
                <button class="pf-btn menu_button pf-popup-ok">적용</button>
                <button class="pf-btn menu_button pf-popup-cancel">취소</button>
            </div>`;
        const overlay = createModalOverlay(inner);
        const bgP = inner.querySelector('.pf-cbg'), bgH = inner.querySelector('.pf-cbg-hex');
        const txP = inner.querySelector('.pf-ctx'), txH = inner.querySelector('.pf-ctx-hex');
        bgP.addEventListener('input', () => bgH.value = bgP.value);
        bgH.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(bgH.value)) bgP.value = bgH.value; });
        txP.addEventListener('input', () => txH.value = txP.value);
        txH.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(txH.value)) txP.value = txH.value; });
        inner.querySelector('.pf-reset-bg').addEventListener('click', () => { bgP.value = '#3a3a3a'; bgH.value = ''; });
        inner.querySelector('.pf-reset-tx').addEventListener('click', () => { txP.value = '#cccccc'; txH.value = ''; });
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const n = inner.querySelector('.pf-edit-name').value.trim();
            if (n) renameFolder(folder.id, n);
            setFolderColor(folder.id, bgH.value, txH.value);
            overlay.remove();
        });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
        inner.querySelector('.pf-delete-folder').addEventListener('click', () => {
            overlay.remove();
            showConfirmPopup(`"${folder.name}" 폴더 삭제?\n(프롬프트는 미분류로 이동)`, () => deleteFolder(folder.id));
        });
    }

    /* ─── 미분류 헤더 ─── */
    function createUncategorizedHeader() {
        const header = document.createElement('div');
        header.className = 'pf-uncat-header pf-injected';
        header.textContent = '📋 미분류';
        return header;
    }

    /* ─── 폴더 할당 버튼 (📂) ─── */
    function addFolderButton(row, identifier) {
        if (row.querySelector('.pf-folder-btn')) return;
        const btn = document.createElement('span');
        btn.className = 'pf-folder-btn'; btn.textContent = '📂'; btn.title = '폴더 선택';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showFolderPicker(identifier, btn); });
        // 기존 아이콘들과 나란히 마지막 그리드 열(작업 영역)에 삽입
        const actionsCol = row.lastElementChild;
        if (actionsCol) {
            actionsCol.appendChild(btn);
        } else {
            row.appendChild(btn);
        }
    }

    /* ─── 폴더 선택기 (Folder Picker) ─── */
    function showFolderPicker(identifier, anchorEl) {
        document.querySelectorAll('.pf-picker').forEach(el => el.remove());
        const d = getPresetData();
        const popup = document.createElement('div');
        popup.className = 'pf-picker';
        const cur = d.assignments[identifier];

        const none = document.createElement('div');
        none.className = 'pf-picker-item' + (!cur ? ' pf-picker-selected' : '');
        none.textContent = '미분류' + (!cur ? ' (현재)' : '');
        none.addEventListener('click', () => { assignPrompt(identifier, null); popup.remove(); });
        popup.appendChild(none);

        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) {
            const isCurrent = cur === f.id;
            const item = document.createElement('div');
            item.className = 'pf-picker-item' + (isCurrent ? ' pf-picker-selected' : '');
            item.textContent = '📁 ' + f.name + (isCurrent ? ' (현재)' : '');
            if (f.bgColor) item.style.borderLeft = `4px solid ${f.bgColor}`;
            item.addEventListener('click', () => { assignPrompt(identifier, f.id); popup.remove(); });
            popup.appendChild(item);
        }

        document.body.appendChild(popup);
        const r = anchorEl.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.top = Math.min(r.bottom + 2, window.innerHeight - 200) + 'px';
        popup.style.left = Math.min(r.left, window.innerWidth - 180) + 'px';
        popup.style.zIndex = '99999';

        setTimeout(() => {
            const h = (e) => { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', h, true); document.removeEventListener('touchend', h, true); } };
            document.addEventListener('click', h, true);
            document.addEventListener('touchend', h, true);
        }, 50);

        // 모바일 패널 닫힘 방지
        const stopProp = (e) => e.stopPropagation();
        popup.addEventListener('mousedown', stopProp);
        popup.addEventListener('touchstart', stopProp, { passive: false });
        popup.addEventListener('mouseup', stopProp);
        popup.addEventListener('touchend', stopProp);
        popup.addEventListener('touchcancel', stopProp);
        popup.addEventListener('click', stopProp);
    }

    /* ─── 폴더 추가 팝업 ─── */
    function showAddFolderPopup() {
        const list = getListContainer();
        const rows = list ? getPromptRows(list) : [];
        const d = getPresetData();
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        let html = '';
        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const name = getPromptName(row);
            const a = d.assignments[id];
            const fo = a ? d.folders.find(f => f.id === a) : null;
            const badge = fo ? `<span class="pf-badge">${fo.name}</span>` : '';
            html += `<label class="pf-prompt-check" data-folder="${a || ''}"><input type="checkbox" value="${id}"><span class="pf-prompt-name">${name}</span>${badge}</label>`;
        }
        // 필터 옵션 생성
        let filterHTML = '<option value="__all__">전체</option><option value="">미분류</option>';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) filterHTML += `<option value="${f.id}">📁 ${f.name}</option>`;

        inner.innerHTML = `
            <div class="pf-popup-title">📁 새 폴더 추가</div>
            <div class="pf-popup-field"><label>이름:</label><input type="text" class="pf-popup-name text_pole" placeholder="폴더 이름…"></div>
            <div class="pf-popup-field"><label>프롬프트 선택 (선택사항):</label>
                <div class="pf-filter-row">
                    <select class="pf-category-filter text_pole">${filterHTML}</select>
                    <label class="pf-select-all-label"><input type="checkbox" class="pf-add-check-all"> 전체 선택</label>
                </div>
                <div class="pf-prompt-list">${html}</div></div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">추가</button><button class="pf-btn menu_button pf-popup-cancel">취소</button></div>`;

        setupCategoryFilter(inner);

        const overlay = createModalOverlay(inner);
        const ni = inner.querySelector('.pf-popup-name');
        setTimeout(() => ni.focus(), 50);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const name = ni.value.trim();
            if (!name) { ni.style.borderColor = 'red'; return; }
            const fid = addFolder(name);
            const dd = getPresetData();
            inner.querySelectorAll('.pf-prompt-check input:checked').forEach(cb => { dd.assignments[cb.value] = fid; });
            markDirty(); overlay.remove(); rebuildFolderUI();
        });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
        ni.addEventListener('keydown', (e) => { if (e.key === 'Enter') inner.querySelector('.pf-popup-ok').click(); });
    }

    /* ─── 확인 팝업 (Confirm Popup) ─── */
    function showConfirmPopup(msg, onOk) {
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        inner.innerHTML = `<div class="pf-popup-title">⚠️ 확인</div><div class="pf-confirm-msg">${msg}</div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">삭제</button><button class="pf-btn menu_button pf-popup-cancel">취소</button></div>`;
        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => { onOk(); overlay.remove(); });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
    }

    /* ─── Alert Popup (확인 버튼만) ─── */
    function showAlertPopup(msg) {
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        inner.innerHTML = `<div class="pf-popup-title">✅ 알림</div><div class="pf-confirm-msg">${msg}</div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">확인</button></div>`;
        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => overlay.remove());
    }

    /* ─── 대량 편집 팝업 (Bulk Edit Popup) ─── */
    function showBulkEditPopup() {
        const list = getListContainer();
        const rows = list ? getPromptRows(list) : [];
        const d = getPresetData();
        if (!d.folders.length) { showConfirmPopup('먼저 폴더를 추가하세요', () => { }); return; }
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        let plHTML = '';
        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const name = getPromptName(row);
            const a = d.assignments[id];
            const fo = a ? d.folders.find(f => f.id === a) : null;
            const badge = fo ? `<span class="pf-badge">${fo.name}</span>` : '<span class="pf-badge pf-badge-none">미분류</span>';
            plHTML += `<label class="pf-prompt-check" data-folder="${a || ''}"><input type="checkbox" value="${id}"><span class="pf-prompt-name">${name}</span>${badge}</label>`;
        }
        let foHTML = '<option value="">미분류</option>';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) foHTML += `<option value="${f.id}">📁 ${f.name}</option>`;
        // 필터 옵션
        let filterHTML = '<option value="__all__">전체</option><option value="">미분류</option>';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) filterHTML += `<option value="${f.id}">📁 ${f.name}</option>`;

        inner.innerHTML = `
            <div class="pf-popup-title">📋 대량 편집</div>
            <div class="pf-popup-field"><label>프롬프트 이동:</label>
                <div class="pf-filter-row">
                    <select class="pf-category-filter text_pole">${filterHTML}</select>
                    <label class="pf-select-all-label"><input type="checkbox" class="pf-bulk-check-all"> 전체 선택</label>
                </div>
                <div class="pf-prompt-list">${plHTML}</div></div>
            <div class="pf-popup-field"><label>이동할 폴더:</label><select class="pf-bulk-target text_pole">${foHTML}</select></div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">이동</button><button class="pf-btn menu_button pf-popup-cancel">취소</button></div>`;

        setupCategoryFilter(inner);

        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const t = inner.querySelector('.pf-bulk-target').value || null;
            const dd = getPresetData();
            inner.querySelectorAll('.pf-prompt-check input:checked').forEach(cb => {
                if (t) dd.assignments[cb.value] = t; else delete dd.assignments[cb.value];
            });
            markDirty(); overlay.remove(); rebuildFolderUI();
        });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
    }

    /* ─── 설정 가져오기 ─── */
    function showImportSettingsPopup() {
        const { extensionSettings } = ctx();
        const allPresets = extensionSettings[MODULE_NAME]?.presets || {};
        const presetNames = Object.keys(allPresets).filter(p => p !== workingPreset);

        if (presetNames.length === 0) {
            showAlertPopup('가져올 다른 프리셋이 없습니다.');
            return;
        }

        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';

        let options = '';
        presetNames.forEach(p => options += `<option value="${p}">${p}</option>`);

        inner.innerHTML = `
            <div class="pf-popup-title">📥 다른 프리셋에서 설정 가져오기</div>
            <div class="pf-popup-field">
                <label>가져올 프리셋:</label>
                <select class="pf-import-select text_pole">${options}</select>
            </div>
            <div class="pf-popup-field" style="margin-top:8px;display:flex;align-items:center;gap:6px;">
                <label style="display:flex;align-items:center;gap:6px;white-space:nowrap;"><input type="checkbox" class="pf-import-order-check"> 폴더/프롬프트 순서도 가져오기</label>
            </div>
            <div class="pf-popup-field" style="font-size:12px;color:#aaa;margin-top:10px;line-height:1.4;">
                <span class="pf-import-desc">현재 프롬프트 순서를 유지한 채 폴더 구조만 가져옵니다.</span>
            </div>
            <div class="pf-popup-actions">
                <button class="pf-btn menu_button pf-popup-ok">가져오기</button>
                <button class="pf-btn menu_button pf-popup-cancel">취소</button>
            </div>`;

        const orderCheck = inner.querySelector('.pf-import-order-check');
        const desc = inner.querySelector('.pf-import-desc');
        orderCheck.addEventListener('change', () => {
            desc.textContent = orderCheck.checked
                ? '소스 프리셋의 폴더 순서와 프롬프트 순서를 그대로 가져와 덮어씁니다.'
                : '현재 프롬프트 순서를 유지한 채 폴더 구조만 가져옵니다.';
        });

        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const presetName = inner.querySelector('.pf-import-select').value;
            if (presetName && allPresets[presetName]) {
                const importOrder = orderCheck.checked;
                importSettingsFromPreset(allPresets[presetName], importOrder);
                overlay.remove();
                showAlertPopup('폴더 설정을 성공적으로 가져왔습니다.');
            }
        });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
    }

    function importSettingsFromPreset(sourceData, importOrder) {
        if (!sourceData || !sourceData.folders) return;
        const d = getPresetData();

        console.log('[PF] IMPORT START, importOrder:', importOrder);
        console.log('[PF] current folders:', d.folders.map(f => `${f.name}(order=${f.order})`).join(', '));

        // ★ 순서를 가져오지 않을 경우 기존 폴더 순서 백업
        const savedOrders = {};
        if (!importOrder) {
            d.folders.forEach(f => { savedOrders[f.id] = f.order; });
        }

        const folderIdMap = {};

        // ★ 새 폴더의 올바른 생성을 위해 항상 소스 폴더를 표시 순서대로 정렬
        const srcFolders = [...sourceData.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        // 새 폴더를 덧붙이기 위해 기존 최대 순서 추적
        const maxExistingOrder = d.folders.length > 0
            ? Math.max(...d.folders.map(f => f.order)) + 1
            : 0;
        let nextNewOrder = maxExistingOrder;

        srcFolders.forEach(srcFolder => {
            let existing = d.folders.find(f => f.name === srcFolder.name);
            if (existing) {
                folderIdMap[srcFolder.id] = existing.id;
                if (importOrder) {
                    existing.order = srcFolder.order ?? existing.order;
                }
            } else {
                const newId = 'pf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                d.folders.push({
                    id: newId,
                    name: srcFolder.name,
                    collapsed: srcFolder.collapsed,
                    order: nextNewOrder,
                    bgColor: srcFolder.bgColor || '',
                    textColor: srcFolder.textColor || ''
                });
                nextNewOrder++;
                folderIdMap[srcFolder.id] = newId;
            }
        });

        // 할당 적용
        if (sourceData.assignments) {
            Object.keys(sourceData.assignments).forEach(identifier => {
                const srcFolderId = sourceData.assignments[identifier];
                const destFolderId = folderIdMap[srcFolderId];
                if (destFolderId) {
                    d.assignments[identifier] = destFolderId;
                }
            });
        }

        if (importOrder) {
            // ★ 소스의 폴더 순서 사용
            const sorted = [...d.folders].sort((a, b) => a.order - b.order);
            sorted.forEach((f, i) => f.order = i);
        } else {
            // ★ 기존 폴더의 백업된 순서 복원
            d.folders.forEach(f => {
                if (savedOrders[f.id] !== undefined) f.order = savedOrders[f.id];
            });

            // ★ 현재 DOM 프롬프트 순서로부터 새 폴더 순서 파생
            const list = getListContainer();
            if (list) {
                const rows = getPromptRows(list);
                const firstAppearance = {};
                rows.forEach((row, idx) => {
                    const id = row.getAttribute('data-pm-identifier');
                    const folderId = d.assignments[id];
                    if (folderId && !(folderId in firstAppearance)) {
                        firstAppearance[folderId] = idx;
                    }
                });
                // 프롬프트 위치를 기준으로 (백업된 순서가 없는) 새 폴더만 재정렬
                d.folders.forEach(f => {
                    if (savedOrders[f.id] === undefined && firstAppearance[f.id] !== undefined) {
                        // 새 폴더: 첫 번째 프롬프트가 나타나는 위치를 기준으로 순서 설정
                        f.order = 1000 + firstAppearance[f.id];
                    }
                });
            }
            // 순차적으로 재정규화
            const sorted = [...d.folders].sort((a, b) => a.order - b.order);
            sorted.forEach((f, i) => f.order = i);
        }

        console.log('[PF] after order fix:', d.folders.map(f => `${f.name}(order=${f.order})`).join(', '));

        markDirty();

        // ★ 순서를 가져올 때, UI 재구성(rebuild) 전에 DOM과 ST 데이터를 재정렬
        if (importOrder && sourceData.promptOrder && sourceData.promptOrder.length > 0) {
            d.promptOrder = [...sourceData.promptOrder];

            // 소스 프롬프트 순서에 맞춰 DOM 행 재정렬
            const list = getListContainer();
            if (list) {
                const rows = getPromptRows(list);
                if (rows.length > 0) {
                    const orderMap = {};
                    sourceData.promptOrder.forEach((id, idx) => { orderMap[id] = idx; });
                    const sortedRows = [...rows].sort((a, b) => {
                        const pA = orderMap[a.getAttribute('data-pm-identifier')] ?? 999999;
                        const pB = orderMap[b.getAttribute('data-pm-identifier')] ?? 999999;
                        return pA - pB;
                    });
                    const parent = rows[0].parentElement;
                    sortedRows.forEach(row => parent.appendChild(row));
                }
            }

            // ST의 메모리 데이터에도 적용
            const ss = getServiceSettings();
            if (ss) {
                if (ss.prompts) {
                    const promptMap = {};
                    ss.prompts.forEach(p => { promptMap[p.identifier] = p; });
                    const reordered = [];
                    const used = new Set();
                    for (const id of sourceData.promptOrder) {
                        if (promptMap[id]) { reordered.push(promptMap[id]); used.add(id); }
                    }
                    for (const p of ss.prompts) {
                        if (!used.has(p.identifier)) reordered.push(p);
                    }
                    ss.prompts.length = 0;
                    reordered.forEach(p => ss.prompts.push(p));
                }
                if (ss.prompt_order) {
                    reorderPromptOrderEntries(ss, sourceData.promptOrder);
                }
                console.log('[PF] applied source prompt order to ST');
            }
        }

        // ★ UI 재구성 (올바른 폴더 내 순서를 위해 재정렬된 DOM을 탐색합니다)
        isImporting = true;
        rebuildFolderUI();
        isImporting = false;

        console.log('[PF] IMPORT DONE, final folders:', d.folders.map(f => `${f.name}(order=${f.order})`).join(', '));
    }


    /* ─── 카테고리 필터 도우미 ─── */
    function setupCategoryFilter(container) {
        const filterSel = container.querySelector('.pf-category-filter');
        const checkAll = container.querySelector('.pf-add-check-all, .pf-bulk-check-all');
        if (!filterSel) return;

        function updateEmptyState() {
            const promptList = container.querySelector('.pf-prompt-list');
            if (!promptList) return;
            let existing = promptList.querySelector('.pf-empty-msg');
            const visibleItems = promptList.querySelectorAll('.pf-prompt-check:not([style*="display: none"])');
            if (visibleItems.length === 0) {
                if (!existing) {
                    existing = document.createElement('div');
                    existing.className = 'pf-empty-msg';
                    existing.textContent = '프롬프트가 없습니다.';
                    promptList.appendChild(existing);
                }
                existing.style.display = '';
            } else if (existing) {
                existing.style.display = 'none';
            }
        }

        filterSel.addEventListener('change', () => {
            const val = filterSel.value;
            container.querySelectorAll('.pf-prompt-check').forEach(label => {
                const folder = label.getAttribute('data-folder');
                label.style.display = (val === '__all__' || folder === val) ? '' : 'none';
            });
            if (checkAll) checkAll.checked = false;
            updateEmptyState();
        });

        if (checkAll) {
            checkAll.addEventListener('change', (e) => {
                container.querySelectorAll('.pf-prompt-check').forEach(label => {
                    if (label.style.display !== 'none') {
                        const cb = label.querySelector('input[type="checkbox"]');
                        if (cb) cb.checked = e.target.checked;
                    }
                });
            });
        }
    }

    /* ─── 폴더 이동 (DnD를 위해 스왑이 아닌 삽입) ─── */
    function moveFolderToPosition(srcId, targetId, before) {
        const d = getPresetData();
        const sorted = [...d.folders].sort((a, b) => a.order - b.order);
        const srcIdx = sorted.findIndex(f => f.id === srcId);
        if (srcIdx < 0) return;
        const srcFolder = sorted[srcIdx];
        // 정렬된 배열에서 소스 폴더 제거
        sorted.splice(srcIdx, 1);
        // 새로운 배열(제거 후)에서 타겟 인덱스 찾기
        let tgtIdx = sorted.findIndex(f => f.id === targetId);
        if (tgtIdx < 0) return;
        // 타겟 앞 또는 뒤에 삽입
        if (!before) tgtIdx += 1;
        sorted.splice(tgtIdx, 0, srcFolder);
        // 순차적 순서 재할당
        sorted.forEach((f, i) => f.order = i);
        markDirty(); needsSTSync = true; rebuildFolderUI();
    }

    /* ─── 폴더 안의 모든 프롬프트 토글 ─── */
    function toggleAllPromptsInFolder(folderId) {
        const d = getPresetData();
        const ids = Object.entries(d.assignments).filter(([, v]) => v === folderId).map(([k]) => k);
        const list = getListContainer();
        if (!list || !ids.length) return;

        // 행과 현재 토글 상태 수집
        const rowData = [];
        for (const pid of ids) {
            const row = list.querySelector(`[data-pm-identifier="${pid}"]`);
            if (!row) continue;
            const toggle = row.querySelector('input[type="checkbox"], .toggle-prompt, [data-pm-toggle], .fa-toggle-on, .fa-toggle-off');
            if (!toggle) continue;
            const isOn = (toggle.type === 'checkbox') ? toggle.checked : toggle.classList.contains('fa-toggle-on');
            rowData.push({ toggle, isOn });
        }
        if (!rowData.length) return;

        // 켜진 것이 하나라도 있으면 → 모두 끄기, 아니면 모두 켜기
        const anyOn = rowData.some(r => r.isOn);
        const targetState = !anyOn; // true = 켜기, false = 끄기

        for (const { toggle, isOn } of rowData) {
            if (isOn !== targetState) toggle.click();
        }
    }

    /* ─── 검색 필터 ─── */
    function applySearchFilter(rows) {
        if (!searchQuery) return;
        const d = getPresetData();
        const mf = new Set();
        let hasVisibleUnassigned = false;
        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const n = getPromptName(row).toLowerCase();
            const c = (row.title || '').toLowerCase();
            if (n.includes(searchQuery) || c.includes(searchQuery)) {
                row.style.display = '';
                const fId = d.assignments[id];
                if (fId) mf.add(fId); else hasVisibleUnassigned = true;
            } else { row.style.display = 'none'; }
        }
        document.querySelectorAll('.pf-folder-header').forEach(h => {
            const fId = h.getAttribute('data-pf-folder-id');
            const vis = Array.from(document.querySelectorAll(`[data-pf-folder="${fId}"]`)).some(r => r.style.display !== 'none');
            h.style.display = (mf.has(fId) || vis) ? '' : 'none';
        });
        // 일치하는 미분류 프롬프트가 없으면 미분류 헤더 숨기기
        document.querySelectorAll('.pf-uncat-header').forEach(h => {
            h.style.display = hasVisibleUnassigned ? '' : 'none';
        });
    }

    /* ─── 주기적 확인 (Periodic check) ─── */
    function periodicCheck() {
        const list = getListContainer();
        if (!list || searchHasFocus) return;
        const cp = getCurrentPresetName();
        if (cp !== lastPreset) {
            const isFirstLoad = (lastPreset === '');
            lastPreset = cp;
            loadWorkingData(isFirstLoad); // 전환된 경우 저장되지 않은 내용을 버리고 저장된 데이터에서 다시 불러오기
            list.querySelectorAll('.pf-toolbar').forEach(el => el.remove());
            rebuildFolderUI(); return;
        }
        if (!list.querySelector('.pf-injected')) rebuildFolderUI();
    }

    /* ─── MutationObserver 관찰자 ─── */
    function setupObserver() {
        const target = document.getElementById('completion_prompt_manager') || document.querySelector('.completion_prompt_manager');
        if (!target) return;
        if (observer) observer.disconnect();
        observer = new MutationObserver(() => {
            if (searchHasFocus) return;
            const list = getListContainer();
            if (list && !list.querySelector('.pf-injected') && !isRebuilding) rebuildFolderUI();
        });
        observer.observe(target, { childList: true, subtree: true });
    }

    /* ─── 슬래시 명령어 (Slash Commands) ─── */
    function registerSlashCommands() {
        try {
            const context = ctx();
            if (!context) return;

            // SillyTavern 객체에서 SlashCommandParser 접근도 시도
            const SlashCommandParser = (window.SillyTavern && window.SillyTavern.getContext().SlashCommandParser) || null;
            const registerSlashCommand = context.registerSlashCommand || (SlashCommandParser ? SlashCommandParser.addCommandObject.bind(SlashCommandParser) : null);

            // 일반적인 슬래시 명령어 등록을 위한 접근 방식
            const registerCmd = (name, callback, helpStr) => {
                try {
                    if (context.registerSlashCommand) {
                        context.registerSlashCommand(name, callback, [], helpStr);
                    } else if (window.registerSlashCommand) {
                        window.registerSlashCommand(name, callback, [], helpStr);
                    }
                } catch (e) { console.warn(`[PF] Failed to register /${name}:`, e); }
            };

            // /togglechd [폴더이름]
            registerCmd('toggle', (args, value) => {
                const folderName = (value || '').trim();
                if (!folderName) return 'Usage: /togglechd [폴더이름]';
                const d = getPresetData();
                const folder = d.folders.find(f => f.name === folderName);
                if (!folder) return `폴더 "${folderName}"을(를) 찾을 수 없습니다.`;
                toggleAllPromptsInFolder(folder.id);
                return `폴더 "${folderName}" 토글 완료`;
            }, '폴더 내 모든 프롬프트 토글 — /togglechd [폴더이름]');

            // /newchd [폴더이름]
            registerCmd('newchd', (args, value) => {
                const folderName = (value || '').trim();
                if (!folderName) return 'Usage: /newchd [폴더이름]';
                addFolder(folderName);
                return `폴더 "${folderName}" 추가 완료`;
            }, '새 폴더 추가 — /newchd [폴더이름]');

            // /editchd [폴더이름]
            registerCmd('editchd', (args, value) => {
                const folderName = (value || '').trim();
                if (!folderName) return 'Usage: /editchd [폴더이름]';
                const d = getPresetData();
                const folder = d.folders.find(f => f.name === folderName);
                if (!folder) return `폴더 "${folderName}"을(를) 찾을 수 없습니다.`;
                showFolderEditPopup(folder);
                return `폴더 "${folderName}" 편집 팝업 표시`;
            }, '폴더 편집 — /editchd [폴더이름]');

            console.log('[PF] Slash commands registered: /togglechd, /newchd, /editchd');
        } catch (e) {
            console.warn('[PF] Slash commands registration failed:', e);
        }
    }

    /* ─── 초기화 (Init) ─── */
    function init() {
        console.log('[Prompt Folders] loaded');
        pollTimer = setInterval(periodicCheck, POLL_MS);
        hookSaveButton();
        registerSlashCommands();
        const trySetup = () => {
            const list = getListContainer();
            if (list) { setupObserver(); rebuildFolderUI(); }
            else setTimeout(trySetup, 1000);
        };
        trySetup();
    }

    if (typeof jQuery !== 'undefined') jQuery(init);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();

