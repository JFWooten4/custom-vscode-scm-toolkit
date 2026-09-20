// Runs as part of the Codex webview bundle when the optional countdown is enabled.
(() => {
    const tagName = 'scm-toolkit-usage-reset-countdown';
    if (customElements.get(tagName)) return;

    class UsageResetCountdown extends HTMLElement {
        connectedCallback() {
            this.update();
            this.timer = setInterval(() => this.update(), 1000);
        }

        disconnectedCallback() {
            clearInterval(this.timer);
        }

        static get observedAttributes() {
            return ['reset-at'];
        }

        attributeChangedCallback() {
            this.update();
        }

        update() {
            const prefix = this.previousSibling;
            if (prefix?.nodeType === Node.TEXT_NODE) {
                prefix.textContent = prefix.textContent
                    .replace(/\b(resets?|renews?) on $/i, '$1 in ')
                    .replace(/\bafter $/i, 'in ')
                    .replace(/\bwait until $/i, 'wait ');
            }

            const resetAt = Number(this.getAttribute('reset-at')) * 1000;
            if (!Number.isFinite(resetAt)) {
                this.textContent = '';
                return;
            }

            const totalMinutes = Math.max(0, Math.round((resetAt - Date.now()) / 60_000));
            const days = Math.floor(totalMinutes / (24 * 60));
            const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
            const minutes = totalMinutes % 60;
            const parts = [];
            if (days) parts.push(`${days}d`);
            if (hours) parts.push(`${hours}h`);
            if (minutes || parts.length === 0) parts.push(`${minutes}m`);
            this.textContent = parts.join(' ');
        }
    }

    customElements.define(tagName, UsageResetCountdown);
})();
