import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ChevronDownIcon } from "../icons.js";

const html = htm.bind(h);

const clampIndex = (value, length) => {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(length - 1, value));
};

const getOptionDetail = (option) => {
  const count = Number(option?.modelCount || 0);
  if (count > 0) return `${count} ${count === 1 ? "model" : "models"}`;
  return "";
};

export const ProviderSelect = ({
  value = "",
  options = [],
  onChange = () => {},
  placeholder = "Select an option",
}) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);
  const selectedIndex = useMemo(
    () => options.findIndex((option) => option?.id === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const selectedLabel = selectedOption?.label || placeholder;
  const selectedDetail = selectedOption ? getOptionDetail(selectedOption) : "";

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(clampIndex(selectedIndex >= 0 ? selectedIndex : 0, options.length));
  }, [open, options.length, selectedIndex]);

  const selectOption = (option) => {
    const nextValue = String(option?.id || "");
    if (!nextValue) return;
    onChange(nextValue);
    setOpen(false);
  };

  const handleTriggerKeyDown = (event) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) =>
        clampIndex((current >= 0 ? current : selectedIndex) + delta, options.length),
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      selectOption(options[activeIndex]);
    }
  };

  return html`
    <div class="relative" ref=${rootRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded=${open ? "true" : "false"}
        onClick=${() => setOpen((current) => !current)}
        onKeyDown=${handleTriggerKeyDown}
        class="w-full h-[38px] bg-field border border-border rounded-lg pl-3 pr-3 text-sm text-body outline-none focus:border-fg-muted flex items-center justify-between gap-3"
      >
        <span class="min-w-0 flex items-baseline gap-2">
          <span class=${selectedOption ? "truncate" : "truncate text-fg-muted"}>
            ${selectedLabel}
          </span>
          ${selectedDetail
            ? html`<span class="hidden sm:inline shrink-0 text-[11px] text-fg-dim">
                ${selectedDetail}
              </span>`
            : null}
        </span>
        <span
          class=${`shrink-0 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <${ChevronDownIcon} className="w-3 h-3" />
        </span>
      </button>
      ${open
        ? html`
            <div
              class="absolute left-0 right-0 top-full mt-1 z-30 max-h-72 overflow-hidden rounded-lg border border-border bg-modal shadow-2xl"
            >
              <div role="listbox" class="max-h-72 overflow-y-auto py-1">
                ${options.length > 0
                  ? options.map((option, index) => {
                      const selected = option?.id === value;
                      const active = index === activeIndex;
                      const detail = getOptionDetail(option);
                      return html`
                        <button
                          key=${option.id}
                          type="button"
                          role="option"
                          aria-selected=${selected ? "true" : "false"}
                          onMouseEnter=${() => setActiveIndex(index)}
                          onMouseDown=${(event) => event.preventDefault()}
                          onClick=${() => selectOption(option)}
                          class=${`w-full min-h-[38px] px-3 py-1.5 text-left text-sm flex items-center justify-between gap-3 ${
                            selected
                              ? "bg-status-info-bg text-status-info"
                              : active
                                ? "bg-surface text-body"
                                : "text-body hover:bg-surface"
                          }`}
                        >
                          <span class="min-w-0">
                            <span class="block truncate">${option.label}</span>
                          </span>
                          ${detail
                            ? html`<span class="shrink-0 text-[11px] text-fg-dim">
                                ${detail}
                              </span>`
                            : null}
                        </button>
                      `;
                    })
                  : html`
                      <div class="px-3 py-2 text-xs text-fg-muted">
                        No options available
                      </div>
                    `}
              </div>
            </div>
          `
        : null}
    </div>
  `;
};
