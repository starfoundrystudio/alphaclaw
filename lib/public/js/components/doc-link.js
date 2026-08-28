import { h } from "preact";
import htm from "htm";
const html = htm.bind(h);

// External-doc link: underlined accent link plus an "opens in new tab" arrow.
export const docLink = (href, label, className = "") => html`<a
  href=${href}
  target="_blank"
  class="ac-tip-link ${className}"
  >${label}<span aria-hidden="true"> ↗</span></a
>`;
