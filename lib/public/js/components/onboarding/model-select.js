import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ChevronDownIcon } from "../icons.js";
import {
  getOnboardingModelGroups,
  getOnboardingModelLabel,
} from "../../lib/model-config.js";

const html = htm.bind(h);

const clampIndex = (value, length) => {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(length - 1, value));
};

export const ModelSelect = ({
  value = "",
  models = [],
  recommendedModels = [],
  showAllModels = false,
  onChange = () => {},
  placeholder = "Select a model",
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const selectedIndex = useMemo(
    () => models.findIndex((model) => model?.key === value),
    [models, value],
  );
  const selectedModel = selectedIndex >= 0 ? models[selectedIndex] : null;
  const selectedLabel = selectedModel
    ? getOnboardingModelLabel(selectedModel, models)
    : placeholder;
  const filteredGroups = useMemo(() => {
    const normalizedSearch = showAllModels ? search.trim().toLowerCase() : "";
    const catalog = showAllModels
      ? getOnboardingModelGroups({ allModels: models, recommendedModels })
      : [{ id: "models", label: "", models }];
    if (!normalizedSearch) return catalog;
    return catalog
      .map((group) => ({
        ...group,
        models: group.models.filter((model) => {
          const label = getOnboardingModelLabel(model, models);
          const searchable = `${label} ${model?.key || ""}`.toLowerCase();
          return searchable.includes(normalizedSearch);
        }),
      }))
      .filter((group) => group.models.length > 0);
  }, [models, recommendedModels, search, showAllModels]);
  const visibleModels = useMemo(
    () => filteredGroups.flatMap((group) => group.models),
    [filteredGroups],
  );

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
    const visibleSelectedIndex = visibleModels.findIndex((model) => model?.key === value);
    setActiveIndex(
      clampIndex(visibleSelectedIndex >= 0 ? visibleSelectedIndex : 0, visibleModels.length),
    );
  }, [open, value, visibleModels]);

  useEffect(() => {
    if (open && showAllModels) {
      searchRef.current?.focus();
    }
  }, [open, showAllModels]);

  useEffect(() => {
    if (!showAllModels && search) {
      setSearch("");
    }
  }, [search, showAllModels]);

  const selectModel = (model) => {
    const nextKey = String(model?.key || "");
    if (!nextKey) return;
    onChange(nextKey);
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
        clampIndex(
          (current >= 0 ? current : selectedIndex) + delta,
          visibleModels.length,
        ),
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      selectModel(visibleModels[activeIndex]);
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
          <span class=${selectedModel ? "truncate" : "truncate text-fg-muted"}>
            ${selectedLabel}
          </span>
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
              class="absolute left-0 right-0 top-full mt-1 z-30 max-h-80 overflow-hidden rounded-lg border border-border bg-modal shadow-2xl"
            >
              ${showAllModels
                ? html`
                    <div class="p-2 border-b border-border">
                      <input
                        ref=${searchRef}
                        type="search"
                        value=${search}
                        onInput=${(event) => setSearch(event.currentTarget.value)}
                        placeholder="Search models"
                        class="w-full h-8 bg-field border border-border rounded-lg px-2.5 text-xs text-body placeholder:text-fg-dim outline-none focus:border-fg-muted"
                      />
                    </div>
                  `
                : null}
              <div role="listbox" class="max-h-64 overflow-y-auto pt-1 pb-2">
                ${models.length === 0
                  ? html`
                      <div class="px-3 py-2 text-xs text-fg-muted">
                        No models available
                      </div>
                    `
                  : visibleModels.length > 0
                  ? (() => {
                      let optionIndex = 0;
                      return filteredGroups.map((group) => html`
                        <div key=${group.id}>
                          ${showAllModels && group.label
                            ? html`
                                <div class="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase text-fg-dim">
                                  ${group.label}
                                </div>
                              `
                            : null}
                          ${group.models.map((model) => {
                            const index = optionIndex;
                            optionIndex += 1;
                            const selected = model?.key === value;
                            const active = index === activeIndex;
                            return html`
                              <button
                                key=${model.key}
                                type="button"
                                role="option"
                                aria-selected=${selected ? "true" : "false"}
                                onMouseEnter=${() => setActiveIndex(index)}
                                onMouseDown=${(event) => event.preventDefault()}
                                onClick=${() => selectModel(model)}
                                class=${`w-full min-h-[38px] px-3 py-1.5 text-left text-sm flex items-center justify-between gap-3 ${
                                  selected
                                    ? "bg-status-info-bg text-status-info"
                                    : active
                                      ? "bg-surface text-body"
                                      : "text-body hover:bg-surface"
                                }`}
                              >
                                <span class="min-w-0">
                                  <span class="block truncate">
                                    ${getOnboardingModelLabel(model, models)}
                                  </span>
                                </span>
                              </button>
                            `;
                          })}
                        </div>
                      `);
                    })()
                  : html`
                      <div class="px-3 py-2 text-xs text-fg-muted">
                        No models found
                      </div>
                    `}
              </div>
            </div>
          `
        : null}
    </div>
  `;
};
