const {
  Menu,
  Notice,
  Plugin: ObsidianPlugin,
  PluginSettingTab,
  setIcon,
} = require("obsidian"); // eslint-disable-line @typescript-eslint/no-require-imports -- Obsidian loads release bundles as CommonJS.

const DEFAULT_SETTINGS = {
  controlPosition: "top",
  leftClickColumnSearch: true,
};

const VIEW_SELECTOR = ".bases-view";
const HIDDEN_CLASS = "bases-utilities-hidden";
const EMPTY_GROUP_CLASS = "bases-utilities-empty-group";
const HIDDEN_TABLE_ROW_CLASS = "bases-utilities-table-row-hidden";
const VISIBLE_TABLE_ROW_CLASS = "bases-utilities-table-page-row";

module.exports = class BasesUtilitiesPlugin extends ObsidianPlugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    delete this.settings.showSinglePage;
    this.pagers = new Map();
    this.paginatedConfigs = new WeakSet();
    this.pagerByConfig = new WeakMap();
    this.preparedConfigByController = new WeakMap();
    this.controllers = new Set();
    this.dataPrototype = null;
    this.originalApplyLimit = null;
    this.refreshFrame = 0;
    this.pendingHeaderMenu = null;
    this.installMenuHook();

    this.addSettingTab(new BasesUtilitiesSettingTab(this.app, this));

    this.addCommand({
      id: "toggle-current-base-pagination",
      name: "Toggle pagination in current base",
      callback: () => this.toggleCurrentBase(),
    });

    this.addCommand({
      id: "first-page-current-base",
      name: "Go to first page in current base",
      callback: () => {
        const pager = this.getCurrentPager();
        if (pager) pager.goToPage(0, true);
      },
    });

    this.app.workspace.onLayoutReady(() => this.start());
  }

  start() {
    this.documentObserver = new MutationObserver(() => this.scheduleRefresh());
    this.documentObserver.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.documentObserver.disconnect());
    this.register(() => window.cancelAnimationFrame(this.refreshFrame));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefresh()));
    this.refreshAll();
  }

  installMenuHook() {
    const prototype = Menu.prototype;
    const originalShowAtPosition = prototype.showAtPosition;
    if (typeof originalShowAtPosition !== "function") return;
    const getPlugin = () => this;
    const wrappedShowAtPosition = function (position, menuDocument) {
      const plugin = getPlugin();
      const pending = plugin.pendingHeaderMenu;
      if (pending && Date.now() - pending.createdAt < 1000) {
        const sameDocument = !menuDocument || menuDocument === pending.doc;
        const closeToPointer =
          !position ||
          !Number.isFinite(position.x) ||
          !Number.isFinite(position.y) ||
          Math.hypot(position.x - pending.point.x, position.y - pending.point.y) < 80;
        if (sameDocument && closeToPointer) {
          plugin.clearPendingHeaderMenu();
          this.addItem((item) => {
            item
              .setTitle("Search this column")
              .setIcon("search")
              .onClick(() => pending.pager.openSearchPopup(pending.context));
            item.setSection?.("action");
          });
        }
      }
      return originalShowAtPosition.apply(this, arguments);
    };
    prototype.showAtPosition = wrappedShowAtPosition;
    this.menuPrototype = prototype;
    this.originalMenuShowAtPosition = originalShowAtPosition;
    this.wrappedMenuShowAtPosition = wrappedShowAtPosition;
  }

  queueHeaderMenu(pager, context, event) {
    this.clearPendingHeaderMenu();
    const doc = context.header.ownerDocument;
    const pending = {
      pager,
      context,
      doc,
      point: { x: event.clientX, y: event.clientY },
      createdAt: Date.now(),
      fallbackTimer: 0,
    };
    this.pendingHeaderMenu = pending;
    pending.fallbackTimer = doc.defaultView.setTimeout(() => {
      if (this.pendingHeaderMenu !== pending) return;
      this.clearPendingHeaderMenu();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Search this column")
          .setIcon("search")
          .onClick(() => pager.openSearchPopup(context))
      );
      menu.showAtPosition(pending.point, doc);
    }, 500);
  }

  clearPendingHeaderMenu() {
    const pending = this.pendingHeaderMenu;
    if (!pending) return;
    pending.doc.defaultView.clearTimeout(pending.fallbackTimer);
    this.pendingHeaderMenu = null;
  }

  scheduleRefresh() {
    if (this.refreshFrame) return;
    this.refreshFrame = window.requestAnimationFrame(() => {
      this.refreshFrame = 0;
      this.refreshAll();
    });
  }

  refreshAll() {
    const roots = new Set(document.querySelectorAll(VIEW_SELECTOR));

    for (const [root, pager] of this.pagers) {
      if (!root.isConnected || !roots.has(root)) {
        pager.destroy();
        this.pagers.delete(root);
      }
    }

    for (const root of roots) {
      if (root.closest(".bases-utilities-controls")) continue;
      let pager = this.pagers.get(root);
      if (!pager) {
        pager = new NativeBasesUtilities(this, root);
        this.pagers.set(root, pager);
      }
      pager.scheduleUpdate();
    }
  }

  getCurrentPager() {
    const activeLeaf = document.querySelector(".workspace-leaf.mod-active");
    if (activeLeaf) {
      const roots = Array.from(activeLeaf.querySelectorAll(VIEW_SELECTOR));
      const visible = roots.find((root) => root.offsetParent !== null);
      if (visible) return this.pagers.get(visible) || null;
    }

    const visible = Array.from(this.pagers.entries()).find(
      ([root]) => root.offsetParent !== null
    );
    return visible?.[1] || null;
  }

  findControllerForRoot(root) {
    let found = null;
    const inspectLeaf = (leaf) => {
      if (found || !leaf?.view) return;
      const stack = [
        leaf.view,
        leaf.view.currentMode,
        leaf.view.previewMode,
        leaf.view.editMode,
        leaf.view.renderer,
      ].filter(Boolean);
      const seen = new Set();

      while (stack.length && !found) {
        const component = stack.pop();
        if (!component || typeof component !== "object" || seen.has(component)) continue;
        seen.add(component);

        const controller = component.controller;
        if (controller?.viewContainerEl === root) {
          found = controller;
          break;
        }
        if (component.viewContainerEl === root && typeof component.getViewConfig === "function") {
          found = component;
          break;
        }

        if (Array.isArray(component._children)) stack.push(...component._children);
        for (const key of ["currentMode", "previewMode", "editMode", "renderer", "component"]) {
          if (component[key] && typeof component[key] === "object") stack.push(component[key]);
        }
      }
    };

    if (typeof this.app.workspace.iterateAllLeaves === "function") {
      this.app.workspace.iterateAllLeaves(inspectLeaf);
    } else {
      for (const type of ["bases", "markdown"]) {
        for (const leaf of this.app.workspace.getLeavesOfType(type)) inspectLeaf(leaf);
      }
    }
    return found;
  }

  prepareController(controller, config, pager) {
    const data = controller?.view?.data;
    if (!controller || !config || !data || typeof data.applyLimit !== "function") return false;

    let prototypePatched = false;
    if (!this.dataPrototype) {
      const prototype = Object.getPrototypeOf(data);
      const originalApplyLimit = prototype?.applyLimit;
      if (typeof originalApplyLimit !== "function") return false;

      const getPlugin = () => this;
      this.dataPrototype = prototype;
      this.originalApplyLimit = originalApplyLimit;
      prototype.applyLimit = function (entries) {
        const plugin = getPlugin();
        const activePager = plugin.pagerByConfig.get(this.config);
        if (activePager?.enabled) {
          activePager.applyColumnSearch(entries);
          if (activePager.pageSize > 0) {
            const start = activePager.page * activePager.pageSize;
            if (start > 0) entries.splice(0, start);
            if (entries.length > activePager.pageSize) {
              entries.splice(activePager.pageSize, entries.length - activePager.pageSize);
            }
            return;
          }
        }
        return originalApplyLimit.call(this, entries);
      };
      prototypePatched = true;
    }

    const previousConfig = this.preparedConfigByController.get(controller);
    this.paginatedConfigs.add(config);
    this.pagerByConfig.set(config, pager);
    this.preparedConfigByController.set(controller, config);
    this.controllers.add(controller);

    if (previousConfig !== config || prototypePatched) {
      window.requestAnimationFrame(() => controller.requestNotifyView?.());
    }
    return true;
  }

  releaseController(controller, config) {
    if (config) {
      this.paginatedConfigs.delete(config);
      this.pagerByConfig.delete(config);
    }
    if (controller) {
      this.preparedConfigByController.delete(controller);
      window.requestAnimationFrame(() => controller.requestNotifyView?.());
    }
  }

  toggleCurrentBase() {
    const pager = this.getCurrentPager();
    if (!pager) {
      new Notice("Open a base table, cards, or list view first.");
      return;
    }
    pager.setEnabled(!pager.enabled);
    new Notice(`Base pagination ${pager.enabled ? "enabled" : "disabled"}.`);
  }

  async updateSettings(nextSettings) {
    this.settings = Object.assign({}, this.settings, nextSettings);
    await this.saveData(this.settings);
    for (const pager of this.pagers.values()) pager.applySettings();
  }

  onunload() {
    this.clearPendingHeaderMenu();
    if (
      this.menuPrototype &&
      this.menuPrototype.showAtPosition === this.wrappedMenuShowAtPosition
    ) {
      this.menuPrototype.showAtPosition = this.originalMenuShowAtPosition;
    }
    for (const pager of this.pagers?.values() || []) pager.destroy();
    this.pagers?.clear();
    if (this.dataPrototype && this.originalApplyLimit) {
      this.dataPrototype.applyLimit = this.originalApplyLimit;
    }
    for (const controller of this.controllers || []) controller.requestNotifyView?.();
    this.controllers?.clear();
  }
};

class NativeBasesUtilities {
  constructor(plugin, root) {
    this.plugin = plugin;
    this.root = root;
    this.enabled = true;
    this.page = 0;
    this.pageSize = 0;
    this.totalItems = 0;
    this.mode = null;
    this.controller = null;
    this.viewConfig = null;
    this.updateFrame = 0;
    this.ignoreScroll = false;
    this.columnSearch = null;
    this.searchPopup = null;
    this.searchTimer = 0;
    this.isColumnResizing = false;
    this.columnResizeEndTimer = 0;
    this.headerPointerStart = null;
    this.didDragHeader = false;

    this.headerClickHandler = (event) => this.onHeaderClick(event);
    this.headerContextMenuHandler = (event) => this.onHeaderContextMenu(event);
    this.headerPointerDownHandler = (event) => this.onHeaderPointerDown(event);
    this.headerPointerMoveHandler = (event) => this.onHeaderPointerMove(event);
    this.columnResizeEndHandler = () => this.onColumnResizeEnd();
    this.root.addEventListener("click", this.headerClickHandler, { capture: true });
    this.root.addEventListener("contextmenu", this.headerContextMenuHandler, {
      capture: true,
    });
    this.root.addEventListener("pointerdown", this.headerPointerDownHandler, {
      capture: true,
    });
    this.root.ownerDocument.addEventListener("pointerup", this.columnResizeEndHandler, {
      capture: true,
    });
    this.root.ownerDocument.addEventListener("pointermove", this.headerPointerMoveHandler, {
      capture: true,
    });
    this.root.ownerDocument.addEventListener("pointercancel", this.columnResizeEndHandler, {
      capture: true,
    });

    this.controlBars = [this.createControls("top"), this.createControls("bottom")];
    this.root.prepend(this.controlBars[0].element);
    this.root.appendChild(this.controlBars[1].element);
    this.root.addClass("bases-utilities-bound");
    this.host = this.root.closest(".bases-embed, .block-language-base");
    this.host?.addClass("bases-utilities-host");

    this.observer = new MutationObserver((mutations) => {
      if (
        mutations.every((mutation) =>
          this.controlBars.some((controls) => controls.element.contains(mutation.target))
        )
      ) return;
      this.scheduleUpdate();
    });
    this.observer.observe(this.root, { childList: true, subtree: true });
  }

  createControls(location) {
    const controls = document.createElement("nav");
    controls.className = `bases-utilities-controls mod-${location}`;
    controls.setAttribute("aria-label", "Base pagination");

    const firstButton = this.createButton("chevrons-left", "First page", () => {
      this.goToPage(0, true);
    });
    const previousButton = this.createButton("chevron-left", "Previous page", () => {
      this.goToPage(this.page - 1, true);
    });

    const status = document.createElement("span");
    status.className = "bases-utilities-status";
    status.setAttribute("aria-live", "polite");

    const nextButton = this.createButton("chevron-right", "Next page", () => {
      this.goToPage(this.page + 1, true);
    });
    const lastButton = this.createButton("chevrons-right", "Last page", () => {
      this.goToPage(this.pageCount - 1, true);
    });

    controls.append(
      firstButton,
      previousButton,
      status,
      nextButton,
      lastButton
    );
    return {
      element: controls,
      location,
      firstButton,
      previousButton,
      status,
      nextButton,
      lastButton,
    };
  }

  createButton(icon, label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clickable-icon bases-utilities-button";
    button.setAttribute("aria-label", label);
    setIcon(button, icon);
    button.addEventListener("click", handler);
    return button;
  }

  applySettings() {
    if (!this.plugin.settings.leftClickColumnSearch) this.closeSearchPopup();
    this.scheduleUpdate();
  }

  getHeaderContext(target) {
    if (!target || typeof target.closest !== "function") return null;
    const header = target.closest(".bases-thead .bases-td");
    if (!header || !this.root.contains(header)) return null;

    let propertyId = null;
    try {
      propertyId = this.controller?.view?.getCellFromDom?.(header)?.prop || null;
    } catch {
      propertyId = null;
    }

    if (!propertyId) {
      const headers = Array.from(this.root.querySelectorAll(".bases-thead .bases-td"));
      const properties = this.controller?.view?.data?.properties;
      const index = headers.indexOf(header);
      if (index >= 0 && Array.isArray(properties)) propertyId = properties[index] || null;
    }
    if (!propertyId) return null;

    let displayName = String(propertyId);
    try {
      displayName = this.viewConfig?.getDisplayName?.(propertyId) || displayName;
    } catch {
      // Keep the property ID as a safe fallback.
    }
    return { header, propertyId, displayName };
  }

  onHeaderClick(event) {
    if (!this.plugin.settings.leftClickColumnSearch || event.button !== 0) return;
    if (this.didDragHeader || event.target?.closest?.(".bases-table-header-resizer")) {
      return;
    }
    const context = this.getHeaderContext(event.target);
    if (!context) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.openSearchPopup(context);
  }

  onHeaderPointerDown(event) {
    const header = event.target?.closest?.(".bases-thead .bases-td");
    if (!header || !this.root.contains(header)) return;
    window.clearTimeout(this.columnResizeEndTimer);
    this.columnResizeEndTimer = 0;
    this.isColumnResizing = true;
    this.headerPointerStart = { x: event.clientX, y: event.clientY };
    this.didDragHeader = false;
    window.cancelAnimationFrame(this.updateFrame);
    this.updateFrame = 0;
  }

  onHeaderPointerMove(event) {
    if (!this.headerPointerStart) return;
    if (
      Math.abs(event.clientX - this.headerPointerStart.x) > 3 ||
      Math.abs(event.clientY - this.headerPointerStart.y) > 3
    ) {
      this.didDragHeader = true;
    }
  }

  onColumnResizeEnd() {
    if (!this.isColumnResizing) return;
    this.headerPointerStart = null;
    window.clearTimeout(this.columnResizeEndTimer);
    this.columnResizeEndTimer = window.setTimeout(() => {
      this.columnResizeEndTimer = 0;
      this.isColumnResizing = false;
      this.didDragHeader = false;
      this.scheduleUpdate();
    }, 150);
  }

  onHeaderContextMenu(event) {
    const context = this.getHeaderContext(event.target);
    if (!context) return;
    this.plugin.queueHeaderMenu(this, context, event);
  }

  openSearchPopup({ header, propertyId, displayName }) {
    this.closeSearchPopup();
    const doc = header.ownerDocument;
    const popup = doc.createElement("div");
    popup.className = "bases-utilities-search-popover";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", `Search ${displayName}`);

    const title = doc.createElement("div");
    title.className = "bases-utilities-search-title";
    title.setText(`Search ${displayName}`);

    const inputRow = doc.createElement("div");
    inputRow.className = "bases-utilities-search-input-row";
    const icon = doc.createElement("span");
    icon.className = "bases-utilities-search-icon";
    setIcon(icon, "search");
    const input = doc.createElement("input");
    input.type = "search";
    input.className = "bases-utilities-search-input";
    input.placeholder = `Search ${displayName}`;
    input.setAttribute("aria-label", `Search ${displayName}`);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.value = this.columnSearch?.propertyId === propertyId
      ? this.columnSearch.query
      : "";
    const clearButton = doc.createElement("button");
    clearButton.type = "button";
    clearButton.className = "clickable-icon bases-utilities-search-clear";
    clearButton.setAttribute("aria-label", "Clear column search");
    setIcon(clearButton, "x");
    const suggestions = doc.createElement("div");
    suggestions.className = "bases-utilities-search-suggestions";
    suggestions.setAttribute("role", "listbox");
    suggestions.hidden = true;
    inputRow.append(icon, input, clearButton);
    popup.append(title, inputRow, suggestions);
    doc.body.appendChild(popup);

    const rect = header.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const padding = 8;
    popup.style.left = `${Math.max(
      padding,
      Math.min(rect.left, doc.defaultView.innerWidth - popupRect.width - padding)
    )}px`;
    popup.style.top = `${Math.min(
      rect.bottom + 6,
      doc.defaultView.innerHeight - popupRect.height - padding
    )}px`;

    const state = {
      element: popup,
      doc,
      propertyId,
      input,
      suggestions,
      availableValues: this.getColumnSuggestions(propertyId),
      visibleSuggestions: [],
      selectedSuggestion: -1,
    };
    state.onOutsidePointerDown = (event) => {
      if (!popup.contains(event.target)) this.closeSearchPopup();
    };
    state.onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSearchPopup();
        header.focus?.();
      }
    };
    this.searchPopup = state;
    doc.addEventListener("keydown", state.onKeyDown, { capture: true });
    state.outsideTimer = doc.defaultView.setTimeout(() => {
      if (this.searchPopup === state) {
        doc.addEventListener("pointerdown", state.onOutsidePointerDown, { capture: true });
      }
    }, 0);

    input.addEventListener("input", () => {
      this.setColumnSearch(propertyId, input.value);
      this.renderSearchSuggestions(state);
    });
    input.addEventListener("keydown", (event) => {
      if (!state.visibleSuggestions.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.selectedSuggestion =
          (state.selectedSuggestion + 1) % state.visibleSuggestions.length;
        this.updateSelectedSuggestion(state);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        state.selectedSuggestion =
          (state.selectedSuggestion - 1 + state.visibleSuggestions.length) %
          state.visibleSuggestions.length;
        this.updateSelectedSuggestion(state);
      } else if (event.key === "Enter" && state.selectedSuggestion >= 0) {
        event.preventDefault();
        this.chooseSearchSuggestion(
          state,
          state.visibleSuggestions[state.selectedSuggestion]
        );
      }
    });
    clearButton.addEventListener("click", () => {
      input.value = "";
      this.setColumnSearch(propertyId, "", true);
      this.renderSearchSuggestions(state);
      input.focus();
    });
    this.renderSearchSuggestions(state);
    input.focus();
    input.select();
  }

  getColumnSuggestions(propertyId) {
    const results = this.controller?.results;
    if (!(results instanceof Map)) return [];
    let entries = Array.from(results.values());
    if (typeof this.controller.applySearchQuery === "function" && this.viewConfig) {
      try {
        entries = this.controller.applySearchQuery(entries, this.viewConfig.getOrder());
      } catch {
        // The Base result set is still safe to use if native search is unavailable.
      }
    }

    const uniqueValues = new Map();
    for (const entry of entries) {
      for (const value of this.getEntryColumnSuggestionValues(entry, propertyId)) {
        const trimmedValue = value.trim();
        if (!trimmedValue) continue;
        const key = trimmedValue.toLocaleLowerCase();
        if (!uniqueValues.has(key)) uniqueValues.set(key, trimmedValue);
      }
    }
    return Array.from(uniqueValues.values()).sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
    );
  }

  renderSearchSuggestions(state) {
    if (this.searchPopup !== state) return;
    const query = state.input.value.trim().toLocaleLowerCase();
    state.suggestions.empty();
    state.selectedSuggestion = -1;
    state.visibleSuggestions = query
      ? state.availableValues
          .filter((value) => value.toLocaleLowerCase().includes(query))
          .sort((left, right) => {
            const leftStarts = left.toLocaleLowerCase().startsWith(query);
            const rightStarts = right.toLocaleLowerCase().startsWith(query);
            if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
            return left.localeCompare(right, undefined, {
              numeric: true,
              sensitivity: "base",
            });
          })
          .slice(0, 12)
      : [];

    for (const [index, value] of state.visibleSuggestions.entries()) {
      const option = state.doc.createElement("button");
      option.type = "button";
      option.className = "bases-utilities-search-suggestion";
      option.id = `bases-utilities-suggestion-${Date.now()}-${index}`;
      option.setAttribute("role", "option");
      option.setText(value);
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("click", () => this.chooseSearchSuggestion(state, value));
      state.suggestions.appendChild(option);
    }
    const hasSuggestions = state.visibleSuggestions.length > 0;
    state.selectedSuggestion = hasSuggestions ? 0 : -1;
    state.suggestions.hidden = !hasSuggestions;
    state.input.setAttribute("aria-expanded", String(hasSuggestions));
    state.input.removeAttribute("aria-activedescendant");
    if (hasSuggestions) this.updateSelectedSuggestion(state);
  }

  updateSelectedSuggestion(state) {
    const options = Array.from(
      state.suggestions.querySelectorAll(".bases-utilities-search-suggestion")
    );
    options.forEach((option, index) => {
      const selected = index === state.selectedSuggestion;
      option.toggleClass("is-selected", selected);
      option.setAttribute("aria-selected", String(selected));
      if (selected) {
        state.input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    });
  }

  chooseSearchSuggestion(state, value) {
    if (this.searchPopup !== state) return;
    state.input.value = value;
    this.setColumnSearch(state.propertyId, value, true);
    this.closeSearchPopup();
  }

  closeSearchPopup() {
    const state = this.searchPopup;
    if (!state) return;
    state.doc.defaultView.clearTimeout(state.outsideTimer);
    state.doc.removeEventListener("pointerdown", state.onOutsidePointerDown, {
      capture: true,
    });
    state.doc.removeEventListener("keydown", state.onKeyDown, { capture: true });
    state.element.remove();
    this.searchPopup = null;
  }

  setColumnSearch(propertyId, query, immediate = false) {
    const normalizedQuery = String(query || "");
    this.columnSearch = normalizedQuery
      ? { propertyId, query: normalizedQuery }
      : null;
    this.page = 0;
    this.updateHeaderSearchIndicators();
    window.clearTimeout(this.searchTimer);
    const refresh = () => {
      this.searchTimer = 0;
      this.controller?.requestNotifyView?.();
      this.scheduleUpdate();
    };
    if (immediate) refresh();
    else this.searchTimer = window.setTimeout(refresh, 120);
  }

  applyColumnSearch(entries) {
    const propertyId = this.columnSearch?.propertyId;
    const query = this.columnSearch?.query.trim().toLocaleLowerCase();
    if (!propertyId || !query) return entries;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const value = this.getEntryColumnText(entries[index], propertyId);
      if (!value.toLocaleLowerCase().includes(query)) entries.splice(index, 1);
    }
    return entries;
  }

  getEntryColumnText(entry, propertyId) {
    try {
      const result = entry?.getValue?.(propertyId);
      return result == null ? "" : result.toString();
    } catch {
      return "";
    }
  }

  getEntryColumnSuggestionValues(entry, propertyId) {
    let result;
    try {
      result = entry?.getValue?.(propertyId);
    } catch {
      return [];
    }
    if (result == null) return [];

    const possibleLists = [result, result?.value, result?.values, result?.items];
    const list = possibleLists.find((candidate) => Array.isArray(candidate));
    if (list) {
      return list
        .map((value) => (value == null ? "" : value.toString()))
        .filter(Boolean);
    }

    let text = result.toString().trim();
    if (!text) return [];
    if (text.startsWith("[") && text.endsWith("]")) {
      text = text.slice(1, -1).trim();
    }
    return text.includes(",")
      ? text.split(",").map((value) => value.trim()).filter(Boolean)
      : [text];
  }

  updateHeaderSearchIndicators() {
    for (const header of this.root.querySelectorAll(".bases-thead .bases-td")) {
      const context = this.getHeaderContext(header);
      const active = Boolean(
        this.columnSearch?.query &&
        context?.propertyId === this.columnSearch.propertyId
      );
      header.toggleClass("bases-utilities-column-search-active", active);
      let indicator = Array.from(header.children).find((child) =>
        child.hasClass?.("bases-utilities-column-search-indicator")
      );
      if (active && !indicator) {
        indicator = header.ownerDocument.createElement("span");
        indicator.className = "bases-utilities-column-search-indicator";
        indicator.setAttribute("aria-label", "Column search active");
        indicator.setAttribute("data-tooltip-position", "top");
        setIcon(indicator, "filter");
        header.appendChild(indicator);
      } else if (!active && indicator) {
        indicator.remove();
      }
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.page = 0;
    if (!enabled) this.plugin.releaseController(this.controller, this.viewConfig);
    this.update(true);
  }

  scheduleUpdate() {
    if (this.updateFrame || this.isColumnResizing) return;
    this.updateFrame = window.requestAnimationFrame(() => {
      this.updateFrame = 0;
      if (this.isColumnResizing) return;
      this.update(false);
    });
  }

  update(forcePosition) {
    if (!this.root.isConnected) return;
    this.ensureControlsAttached();
    this.clearPagedElements();

    const nextController = this.plugin.findControllerForRoot(this.root);
    const nextViewConfig = nextController?.getViewConfig?.() || null;
    if (nextController && nextViewConfig) {
      if (this.viewConfig && this.viewConfig !== nextViewConfig) {
        this.plugin.paginatedConfigs.delete(this.viewConfig);
        this.plugin.pagerByConfig.delete(this.viewConfig);
      }
      this.controller = nextController;
      this.viewConfig = nextViewConfig;
    }
    const nativeLimit = Number(this.viewConfig?.getLimit?.() || 0);
    const limitChanged = nativeLimit !== this.pageSize;
    if (limitChanged) {
      this.pageSize = nativeLimit;
      this.page = 0;
      forcePosition = true;
    }

    if (this.enabled && this.controller && this.viewConfig) {
      this.plugin.prepareController(this.controller, this.viewConfig, this);
      if (limitChanged) {
        window.requestAnimationFrame(() => this.controller?.requestNotifyView?.());
      }
    }

    const view = this.detectView();
    this.mode = view?.mode || null;
    this.updateHeaderSearchIndicators();

    if (!this.enabled || nativeLimit < 1) {
      this.root.removeClass("bases-utilities-table-limited");
      this.setControlsVisible(false);
      return;
    }
    if (!view || !this.controller) return;

    this.root.removeClass("bases-utilities-table-limited");
    this.totalItems = this.getControllerResultCount();
    const previousPage = this.page;
    this.clampPage();
    if (this.page !== previousPage) {
      window.requestAnimationFrame(() => this.controller?.requestNotifyView?.());
    }

    this.setControlsVisible(true);
    this.updateControls();
  }

  getControllerResultCount() {
    const results = this.controller?.results;
    if (!(results instanceof Map)) return 0;
    const entries = Array.from(results.values());
    if (typeof this.controller.applySearchQuery === "function" && this.viewConfig) {
      try {
        const filtered = this.controller.applySearchQuery(entries, this.viewConfig.getOrder());
        return this.applyColumnSearch(filtered).length;
      } catch {
        return entries.length;
      }
    }
    return this.applyColumnSearch(entries).length;
  }

  ensureControlsAttached() {
    const [top, bottom] = this.controlBars;
    if (top.element.parentElement !== this.root || this.root.firstElementChild !== top.element) {
      this.root.prepend(top.element);
    }
    if (bottom.element.parentElement !== this.root || this.root.lastElementChild !== bottom.element) {
      this.root.appendChild(bottom.element);
    }
  }

  setControlsVisible(shouldShow) {
    const position = ["top", "bottom", "both"].includes(this.plugin.settings.controlPosition)
      ? this.plugin.settings.controlPosition
      : DEFAULT_SETTINGS.controlPosition;
    for (const controls of this.controlBars) {
      const matchesPosition = position === "both" || position === controls.location;
      controls.element.hidden = !shouldShow || !matchesPosition;
    }
  }

  detectView() {
    const tableContainer = this.root.querySelector(".bases-table-container");
    const tableBody = this.root.querySelector(".bases-tbody");
    if (tableContainer && tableBody) {
      return { mode: "table", container: tableContainer, body: tableBody };
    }

    const cards = Array.from(this.root.querySelectorAll(".bases-cards-item"));
    if (cards.length) return { mode: "cards", items: cards };

    const listItems = Array.from(this.root.querySelectorAll(".bases-list-item"));
    if (listItems.length) return { mode: "list", items: listItems };

    return null;
  }

  updateItems(view) {
    this.root.removeClass("bases-utilities-table-limited");
    const items = view.items.filter(
      (item) => !this.controlBars.some((controls) => controls.element.contains(item))
    );
    this.totalItems = items.length;
    this.clampPage();

    const start = this.page * this.pageSize;
    const end = start + this.pageSize;
    items.forEach((item, index) => item.classList.toggle(HIDDEN_CLASS, index < start || index >= end));

    const groupSelector = view.mode === "cards" ? ".bases-cards-group" : ".bases-list-group";
    const itemSelector = view.mode === "cards" ? ".bases-cards-item" : ".bases-list-item";
    for (const group of this.root.querySelectorAll(groupSelector)) {
      const groupItems = Array.from(group.querySelectorAll(itemSelector));
      if (!groupItems.length) continue;
      group.classList.toggle(
        EMPTY_GROUP_CLASS,
        groupItems.every((item) => item.classList.contains(HIDDEN_CLASS))
      );
    }
  }

  updateTable(view, forcePosition) {
    this.tableContainer = view.container;
    this.tableBody = view.body;
    this.rowHeight = this.getRowHeight(view);
    this.totalItems = this.getTableRowCount(view);
    this.clampPage();

    const pageRows = Math.max(
      1,
      Math.min(this.pageSize, this.totalItems - this.page * this.pageSize)
    );
    const headerHeight = this.getTableHeaderHeight(view);
    this.root.addClass("bases-utilities-table-limited");
    this.root.style.setProperty("--bases-utilities-page-size", String(pageRows));
    this.root.style.setProperty("--bases-utilities-row-height", `${this.rowHeight}px`);
    this.root.style.setProperty(
      "--bases-utilities-table-height",
      `${headerHeight + pageRows * this.rowHeight + 2}px`
    );
    this.applyTableRowWindow(view);

    if (!this.tableScrollHandler) {
      this.tableScrollHandler = () => {
        if (this.ignoreScroll) return;
        const nextPage = Math.floor(
          (this.tableContainer.scrollTop + this.rowHeight / 2) /
            (this.pageSize * this.rowHeight)
        );
        if (nextPage !== this.page) {
          this.page = Math.max(0, Math.min(this.pageCount - 1, nextPage));
          this.updateControls();
        }
      };
      view.container.addEventListener("scroll", this.tableScrollHandler, { passive: true });
    } else if (this.tableScrollElement !== view.container) {
      this.tableScrollElement?.removeEventListener("scroll", this.tableScrollHandler);
      view.container.addEventListener("scroll", this.tableScrollHandler, { passive: true });
    }
    this.tableScrollElement = view.container;

    if (forcePosition) this.positionTableAtPage();
  }

  getRowHeight(view) {
    const raw = getComputedStyle(this.root).getPropertyValue("--bases-table-row-height");
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 1) return parsed;

    const row = view.body.querySelector(".bases-tr");
    const measured = row?.getBoundingClientRect().height;
    return measured && measured > 1 ? Math.min(measured, 80) : 40;
  }

  getTableHeaderHeight(view) {
    return this.rowHeight;
  }

  getTableRowCount(view) {
    const dataCount = this.controller?.view?.data?.data?.length;
    if (Number.isFinite(dataCount) && dataCount >= 0) return dataCount;

    const candidates = [
      view.body.getAttribute("aria-rowcount"),
      view.container.getAttribute("aria-rowcount"),
      view.body.dataset.rowCount,
      view.container.dataset.rowCount,
    ];
    for (const candidate of candidates) {
      const count = Number.parseInt(candidate, 10);
      if (Number.isFinite(count) && count >= 0) return count;
    }

    const bodyHeight = Math.max(
      view.body.scrollHeight,
      Number.parseFloat(getComputedStyle(view.body).height) || 0,
      Number.parseFloat(view.body.style.height) || 0
    );
    const estimated = Math.round(bodyHeight / this.rowHeight);
    if (estimated > 0) return estimated;
    return view.body.querySelectorAll(".bases-tr").length;
  }

  applyTableRowWindow(view) {
    const start = this.page * this.pageSize;
    const end = start + this.pageSize;
    const rows = Array.from(view.body.querySelectorAll(".bases-tr"));
    this.tableHasAllRows = rows.length >= this.totalItems;
    const offset = this.tableHasAllRows ? -start * this.rowHeight : 0;

    rows.forEach((row, renderedIndex) => {
      const inlineTop = Number.parseFloat(row.style.top);
      const transform = row.style.transform;
      const translateY = transform.match(/translateY\(\s*(-?[\d.]+)px/i);
      const translate3d = transform.match(
        /translate3d\(\s*-?[\d.]+px\s*,\s*(-?[\d.]+)px/i
      );
      const translate2d = transform.match(
        /translate\(\s*-?[\d.]+px\s*,\s*(-?[\d.]+)px/i
      );
      const translatedTop = Number.parseFloat(
        translateY?.[1] ?? translate3d?.[1] ?? translate2d?.[1]
      );
      const top = Number.isFinite(inlineTop) ? inlineTop : translatedTop;
      const rowIndex = Number.isFinite(top)
        ? Math.max(0, Math.round(top / this.rowHeight))
        : renderedIndex;
      const visible = rowIndex >= start && rowIndex < end;
      row.classList.toggle(HIDDEN_TABLE_ROW_CLASS, !visible);
      row.classList.toggle(VISIBLE_TABLE_ROW_CLASS, visible && this.tableHasAllRows);
      if (visible && this.tableHasAllRows) {
        row.style.setProperty("--bases-utilities-row-offset", `${offset}px`);
      } else {
        row.style.removeProperty("--bases-utilities-row-offset");
      }
    });
  }

  positionTableAtPage() {
    if (!this.tableContainer) return;
    const target = this.tableHasAllRows ? 0 : this.page * this.pageSize * this.rowHeight;
    this.ignoreScroll = true;
    this.tableContainer.scrollTop = target;
    window.requestAnimationFrame(() => {
      this.ignoreScroll = false;
    });
  }

  get pageCount() {
    return Math.max(1, Math.ceil(this.totalItems / this.pageSize));
  }

  clampPage() {
    this.page = Math.max(0, Math.min(this.pageCount - 1, this.page));
  }

  goToPage(page, forcePosition) {
    const nextPage = Math.max(0, Math.min(this.pageCount - 1, page));
    if (nextPage === this.page && !forcePosition) return;
    this.page = nextPage;
    this.updateControls();
    this.controller?.requestNotifyView?.();
    this.controlBars.find((controls) => !controls.element.hidden)?.element.scrollIntoView({
      block: "nearest",
    });
  }

  updateControls() {
    const start = this.totalItems ? this.page * this.pageSize + 1 : 0;
    const end = Math.min(this.totalItems, (this.page + 1) * this.pageSize);
    for (const controls of this.controlBars) {
      controls.status.setText(
        `Page ${this.page + 1} of ${this.pageCount} · ${start}–${end} of ${this.totalItems}`
      );
      controls.firstButton.disabled = this.page <= 0;
      controls.previousButton.disabled = this.page <= 0;
      controls.nextButton.disabled = this.page >= this.pageCount - 1;
      controls.lastButton.disabled = this.page >= this.pageCount - 1;
    }
  }

  clearPagedElements() {
    for (const element of this.root.querySelectorAll(
      `.${HIDDEN_CLASS}, .${EMPTY_GROUP_CLASS}, .${HIDDEN_TABLE_ROW_CLASS}, .${VISIBLE_TABLE_ROW_CLASS}`
    )) {
      element.removeClass(HIDDEN_CLASS);
      element.removeClass(EMPTY_GROUP_CLASS);
      element.removeClass(HIDDEN_TABLE_ROW_CLASS);
      element.removeClass(VISIBLE_TABLE_ROW_CLASS);
      element.style.removeProperty("--bases-utilities-row-offset");
    }
  }

  destroy() {
    this.observer.disconnect();
    window.cancelAnimationFrame(this.updateFrame);
    window.clearTimeout(this.searchTimer);
    window.clearTimeout(this.columnResizeEndTimer);
    this.closeSearchPopup();
    this.root.removeEventListener("click", this.headerClickHandler, { capture: true });
    this.root.removeEventListener("contextmenu", this.headerContextMenuHandler, {
      capture: true,
    });
    this.root.removeEventListener("pointerdown", this.headerPointerDownHandler, {
      capture: true,
    });
    this.root.ownerDocument.removeEventListener("pointerup", this.columnResizeEndHandler, {
      capture: true,
    });
    this.root.ownerDocument.removeEventListener("pointermove", this.headerPointerMoveHandler, {
      capture: true,
    });
    this.root.ownerDocument.removeEventListener("pointercancel", this.columnResizeEndHandler, {
      capture: true,
    });
    for (const header of this.root.querySelectorAll(".bases-utilities-column-search-active")) {
      header.removeClass("bases-utilities-column-search-active");
      header.querySelector(".bases-utilities-column-search-indicator")?.remove();
    }
    this.tableScrollElement?.removeEventListener("scroll", this.tableScrollHandler);
    this.clearPagedElements();
    this.root.removeClass("bases-utilities-bound");
    this.root.removeClass("bases-utilities-table-limited");
    this.root.style.removeProperty("--bases-utilities-page-size");
    this.root.style.removeProperty("--bases-utilities-row-height");
    this.root.style.removeProperty("--bases-utilities-table-height");
    this.host?.removeClass("bases-utilities-host");
    for (const controls of this.controlBars) controls.element.remove();
    this.plugin.releaseController(this.controller, this.viewConfig);
  }
}

class BasesUtilitiesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions() {
    return [
      {
        name: "Open column search on left click",
        desc: "Open a column-specific search when selecting a table header. Search is always available by right-clicking a header.",
        control: {
          type: "toggle",
          key: "leftClickColumnSearch",
        },
      },
      {
        name: "Control position",
        desc: "Choose where pagination controls appear in native base views.",
        control: {
          type: "dropdown",
          key: "controlPosition",
          defaultValue: "top",
          options: {
            top: "Top",
            bottom: "Bottom",
            both: "Both",
          },
        },
      },
    ];
  }

  async setControlValue(key, value) {
    await this.plugin.updateSettings({ [key]: value });
  }
}
