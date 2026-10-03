// Capture external file drops across the VS Code webview, using native upload handlers.
function scmToolkitRegisterImageDropTarget(root, enter, leave, drop) {
    const key = '__scmToolkitImageDropTargets';
    let state = globalThis[key];
    if (!state) {
        const targets = new Set();
        const body = document.body;
        let active;
        const select = event => {
            const entries = [...targets].reverse().filter(entry => !entry.root
                || (entry.root.isConnected !== false && entry.root.getClientRects().length));
            return entries.find(entry => entry.root?.contains(event.target)
                && entry.root.getClientRects().length)
                ?? entries.find(entry => entry.root)
                ?? entries.find(entry => !entry.root);
        };
        const hasFiles = event => {
            const transfer = event.dataTransfer;
            return transfer && (Array.from(transfer.types || []).includes('Files')
                || transfer.files?.length
                || Array.from(transfer.items || []).some(item => item.kind === 'file'));
        };
        const enterTarget = event => {
            if (!hasFiles(event)) return;
            const entry = select(event);
            if (active && active !== entry) active.leave(event);
            const firstEnter = active !== entry;
            active = entry;
            // The native counter must count entry to the pane, not each child.
            const forwarded = new Proxy(event, {
                get(target, property) {
                    if (property === 'type') return firstEnter ? 'dragenter' : 'dragover';
                    if (property === 'currentTarget') return entry?.root ?? body;
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
            entry?.enter(forwarded);
            if (event.defaultPrevented) event.stopPropagation();
        };
        const handlers = {
            dragenter: enterTarget,
            dragover: enterTarget,
            dragleave(event) {
                // Moving across children is still inside the drop target.
                if (event.relatedTarget && body.contains(event.relatedTarget)) return;
                // Chromium can omit relatedTarget when crossing webview children.
                if (!event.relatedTarget && event.clientX > 0 && event.clientY > 0
                    && body.contains(document.elementFromPoint?.(event.clientX, event.clientY))) return;
                (active ?? select(event))?.leave(event);
                active = undefined;
            },
            drop(event) {
                if (!hasFiles(event)) return;
                select(event)?.drop(event);
                active = undefined;
                if (event.defaultPrevented) event.stopPropagation();
            },
        };
        for (const [type, handler] of Object.entries(handlers)) {
            body.addEventListener(type, handler, true);
        }
        state = globalThis[key] = { targets, body, handlers, release(entry) {
            if (active === entry) {
                entry.leave({ type: 'dragleave' });
                active = undefined;
            }
        } };
    }
    const entry = { root, enter, leave, drop };
    state.targets.add(entry);
    return () => {
        state.release(entry);
        state.targets.delete(entry);
        if (state.targets.size) return;
        for (const [type, handler] of Object.entries(state.handlers)) {
            state.body.removeEventListener(type, handler, true);
        }
        delete globalThis[key];
    };
}
