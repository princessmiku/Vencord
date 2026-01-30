/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import { Alerts, Button, ExpressionPickerStore, React, SelectedChannelStore, TextInput, Toasts, createRoot, useCallback, useEffect, useRef, useState } from "@webpack/common";

const MAM_LABEL = "MAM";
const MAM_TAB_ATTR = "data-vc-mam-tab";
const MAM_PANEL_ATTR = "data-vc-mam-panel";
const MAM_BOUND_ATTR = "data-vc-mam-bound";
const MAM_PANEL_ID_ATTR = "data-vc-mam-panel-id";
const MAM_TAB_ID_ATTR = "data-vc-mam-tab-id";
const MAM_OWNER_ATTR = "data-vc-mam-owner";
const API_BASE_URL = "https://www.midevelopment.de/";

type MamRoot = { render: (node: React.ReactNode) => void; unmount: () => void; };
type MagGif = {
    id: number;
    public_url: string;
    nsfw?: boolean;
};

type MagResponse = {
    items: MagGif[];
    pagination?: {
        has_more?: boolean;
        next_page?: number | null;
    };
};

const cleanupFns = new Set<() => void>();
const mamRoots = new WeakMap<HTMLElement, MamRoot>();
let observer: MutationObserver | null = null;
let panelIdCounter = 0;

function MamView() {
    const { apiKey } = settings.use(["apiKey"]);
    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [items, setItems] = useState<MagGif[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        const handle = setTimeout(() => setDebouncedQuery(query.trim()), 250);
        return () => clearTimeout(handle);
    }, [query]);

    useEffect(() => {
        setPage(1);
    }, [debouncedQuery, apiKey]);

    useEffect(() => {
        abortRef.current?.abort();

        if (!apiKey) {
            setLoading(false);
            setItems([]);
            setHasMore(false);
            setError("Set your MAM API key in the plugin settings.");
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
        setError(null);

        const url = new URL("/api/gifs", API_BASE_URL);
        if (debouncedQuery) url.searchParams.set("q", debouncedQuery);
        url.searchParams.set("limit", "20");
        url.searchParams.set("page", String(page));
        url.searchParams.set("nsfw", "false");
        url.searchParams.set("visibility", "published");

        fetch(url, {
            signal: controller.signal,
            headers: {
                "X-API-Key": apiKey
            }
        }).then(async res => {
            if (!res.ok) {
                const message = res.status === 401
                    ? "Invalid API key."
                    : `Request failed (${res.status}).`;
                throw new Error(message);
            }
            return res.json() as Promise<MagResponse>;
        }).then(data => {
            const nextItems = Array.isArray(data.items) ? data.items : [];
            setItems(prev => page === 1 ? nextItems : [...prev, ...nextItems]);
            setHasMore(Boolean(data.pagination?.has_more));
        }).catch(err => {
            if (controller.signal.aborted) return;
            const message = err instanceof Error ? err.message : "Request failed.";
            setError(message);
            setItems(prev => page === 1 ? [] : prev);
            setHasMore(false);
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });

        return () => controller.abort();
    }, [apiKey, debouncedQuery, page]);

    const onSend = useCallback((gif: MagGif) => {
        const channelId = SelectedChannelStore.getChannelId();
        if (!channelId) {
            Toasts.show({
                message: "No channel selected.",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }

        sendMessage(channelId, { content: gif.public_url });
        ExpressionPickerStore.closeExpressionPicker();
    }, []);

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", gap: 8, padding: "8px 12px" }}>
                <TextInput
                    value={query}
                    placeholder="Search MAM GIFs"
                    onChange={setQuery}
                />
                <Button
                    size={Button.Sizes.SMALL}
                    disabled={loading}
                    onClick={() => setPage(1)}
                >
                    Search
                </Button>
            </div>

            {error ? (
                <div style={{ padding: "0 12px 8px", color: "var(--status-danger)" }}>
                    {error}
                </div>
            ) : null}

            <div
                style={{
                    flex: 1,
                    overflow: "auto",
                    padding: "8px 12px 12px",
                    display: "grid",
                    gap: 8,
                    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))"
                }}
            >
                {!loading && !error && items.length === 0 ? (
                    <div style={{ gridColumn: "1 / -1", opacity: 0.7 }}>
                        No results.
                    </div>
                ) : null}

                {items.map(gif => (
                    <button
                        key={gif.id}
                        onClick={() => onSend(gif)}
                        style={{
                            border: "none",
                            padding: 0,
                            background: "transparent",
                            cursor: "pointer"
                        }}
                        aria-label="Send GIF"
                        title="Send GIF"
                    >
                        <img
                            src={gif.public_url}
                            loading="lazy"
                            style={{
                                width: "100%",
                                height: 96,
                                objectFit: "cover",
                                borderRadius: 6
                            }}
                        />
                    </button>
                ))}
            </div>

            <div style={{ display: "flex", justifyContent: "center", padding: "8px 12px 12px", gap: 8 }}>
                {loading ? <div>Loading...</div> : null}
                {!loading && hasMore ? (
                    <Button size={Button.Sizes.SMALL} onClick={() => setPage(p => p + 1)}>
                        Load more
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    apiKey: {
        type: OptionType.STRING,
        description: "MAM API key",
        default: "",
    },
});

function findPickerEntries() {
    const entries: Array<{ tabList: HTMLElement; sampleTab: HTMLElement; samplePanel: HTMLElement; }> = [];
    const seen = new Set<HTMLElement>();
    const panels = document.querySelectorAll<HTMLElement>("[id$=\"picker-tab-panel\"], [id*=\"picker-tab-panel\"]");

    for (const panel of panels) {
        const tab = document.querySelector<HTMLElement>(`[role="tab"][aria-controls="${panel.id}"]`)
            ?? document.querySelector<HTMLElement>(`[aria-controls="${panel.id}"]`);
        if (!tab) continue;

        const tabList = tab.closest<HTMLElement>("[role=\"tablist\"]") ?? tab.parentElement;
        if (!tabList || seen.has(tabList)) continue;

        seen.add(tabList);
        entries.push({ tabList, sampleTab: tab, samplePanel: panel });
    }

    return entries;
}

function getMamIds(tabList: HTMLElement) {
    let panelId = tabList.getAttribute(MAM_PANEL_ID_ATTR);
    let tabId = tabList.getAttribute(MAM_TAB_ID_ATTR);
    if (!panelId || !tabId) {
        const id = ++panelIdCounter;
        panelId = `mam-picker-tab-panel-${id}`;
        tabId = `mam-picker-tab-${id}`;
        tabList.setAttribute(MAM_PANEL_ID_ATTR, panelId);
        tabList.setAttribute(MAM_TAB_ID_ATTR, tabId);
    }
    return { panelId, tabId };
}

function resolveSamplePanel(tabList: HTMLElement, fallback?: HTMLElement) {
    const activeTab = tabList.querySelector<HTMLElement>("[role=\"tab\"][aria-selected=\"true\"], [role=\"tab\"][aria-current=\"page\"]")
        ?? tabList.querySelector<HTMLElement>("[role=\"tab\"]:not([data-vc-mam-tab])")
        ?? tabList.querySelector<HTMLElement>("[role=\"tab\"]");

    const panelId = activeTab?.getAttribute("aria-controls");
    if (panelId) {
        const panel = document.getElementById(panelId);
        if (panel) return panel as HTMLElement;
    }

    if (fallback?.isConnected) return fallback;

    const tabs = tabList.querySelectorAll<HTMLElement>("[role=\"tab\"][aria-controls]");
    for (const tab of tabs) {
        const id = tab.getAttribute("aria-controls");
        if (!id) continue;
        const panel = document.getElementById(id);
        if (panel) return panel as HTMLElement;
    }

    return null;
}

function getActiveClassNames(tabList: HTMLElement, sampleTab: HTMLElement) {
    const activeTab = tabList.querySelector<HTMLElement>("[role=\"tab\"][aria-selected=\"true\"], [role=\"tab\"][aria-current=\"page\"]")
        ?? sampleTab;
    const inactiveTab = tabList.querySelector<HTMLElement>("[role=\"tab\"]:not([aria-selected=\"true\"]):not([aria-current=\"page\"])");

    if (!activeTab) return [] as string[];
    if (!inactiveTab) {
        return Array.from(activeTab.classList).filter(name => name.toLowerCase().includes("active"));
    }

    const inactive = new Set(inactiveTab.classList);
    return Array.from(activeTab.classList).filter(name => !inactive.has(name));
}

function setTabActiveState(tab: HTMLElement, active: boolean, activeClassNames: string[]) {
    tab.setAttribute("aria-selected", active ? "true" : "false");
    if (active) {
        tab.setAttribute("aria-current", "page");
        tab.tabIndex = 0;
        activeClassNames.forEach(name => tab.classList.add(name));
    } else {
        tab.removeAttribute("aria-current");
        tab.tabIndex = -1;
        activeClassNames.forEach(name => tab.classList.remove(name));
    }
}

function ensureMamPanel(samplePanel: HTMLElement, panelId: string): HTMLElement {
    const panelContainer = samplePanel.parentElement ?? samplePanel;
    const orphanPanels = document.querySelectorAll<HTMLElement>(`[${MAM_PANEL_ATTR}][${MAM_OWNER_ATTR}="${panelId}"]`);
    orphanPanels.forEach(panel => {
        if (!panelContainer.contains(panel)) {
            mamRoots.get(panel)?.unmount();
            mamRoots.delete(panel);
            panel.remove();
        }
    });
    let mamPanel = panelContainer.querySelector<HTMLElement>(`[${MAM_PANEL_ATTR}]`);

    if (!mamPanel) {
        mamPanel = samplePanel.cloneNode(false) as HTMLElement;
        mamPanel.setAttribute(MAM_PANEL_ATTR, "");
        mamPanel.setAttribute(MAM_OWNER_ATTR, panelId);
        mamPanel.setAttribute("role", "tabpanel");
        mamPanel.id = panelId;
        mamPanel.style.display = "none";
        mamPanel.innerHTML = "";
        panelContainer.appendChild(mamPanel);
        const root = createRoot(mamPanel) as MamRoot;
        root.render(<MamView />);
        mamRoots.set(mamPanel, root);
    }

    return mamPanel;
}

function setMamActive(tabList: HTMLElement, samplePanel: HTMLElement, active: boolean, activeClassNames: string[]) {
    const resolvedPanel = resolveSamplePanel(tabList, samplePanel);
    if (!resolvedPanel) return;

    const mamTab = tabList.querySelector<HTMLElement>(`[${MAM_TAB_ATTR}]`);
    const mamPanel = ensureMamPanel(resolvedPanel, getMamIds(tabList).panelId);

    const panelContainer = resolvedPanel.parentElement ?? resolvedPanel;
    const panels = panelContainer.querySelectorAll<HTMLElement>("[role=\"tabpanel\"]");
    panels.forEach(panel => {
        if (panel === mamPanel) return;
        if (active) {
            if (panel.style.display !== "none") {
                panel.dataset.vcMamDisplay = panel.style.display;
            }
            if (panel.dataset.vcMamHidden === undefined) {
                panel.dataset.vcMamHidden = panel.hasAttribute("hidden") ? "1" : "0";
            }
            panel.style.display = "none";
            panel.setAttribute("hidden", "");
        } else if (panel.dataset.vcMamDisplay !== undefined) {
            panel.style.display = panel.dataset.vcMamDisplay;
            delete panel.dataset.vcMamDisplay;
            if (panel.dataset.vcMamHidden !== undefined) {
                if (panel.dataset.vcMamHidden === "1") panel.setAttribute("hidden", "");
                else panel.removeAttribute("hidden");
                delete panel.dataset.vcMamHidden;
            }
        }
    });

    if (mamTab) {
        if (active) {
            const otherTabs = tabList.querySelectorAll<HTMLElement>("[role=\"tab\"]");
            otherTabs.forEach(tab => {
                if (tab === mamTab) return;
                setTabActiveState(tab, false, activeClassNames);
            });
        }
        setTabActiveState(mamTab, active, activeClassNames);
    }

    mamPanel.style.display = active ? "" : "none";
    if (active) mamPanel.removeAttribute("hidden");
    else mamPanel.setAttribute("hidden", "");
}

function injectMamTab(tabList: HTMLElement, sampleTab: HTMLElement, samplePanel: HTMLElement) {
    if (tabList.hasAttribute(MAM_BOUND_ATTR)) return;
    tabList.setAttribute(MAM_BOUND_ATTR, "true");

    if (!sampleTab) return;

    const { panelId, tabId } = getMamIds(tabList);
    const activeClassNames = getActiveClassNames(tabList, sampleTab);

    const mamTab = sampleTab.cloneNode(true) as HTMLElement;
    mamTab.setAttribute(MAM_TAB_ATTR, "");
    mamTab.setAttribute("role", "tab");
    mamTab.setAttribute("aria-controls", panelId);
    mamTab.setAttribute("id", tabId);
    mamTab.textContent = MAM_LABEL;
    setTabActiveState(mamTab, false, activeClassNames);

    const onMamClick = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        setMamActive(tabList, samplePanel, true, activeClassNames);
        requestAnimationFrame(() => setMamActive(tabList, samplePanel, true, activeClassNames));
    };

    const onMamMouseDown = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        setMamActive(tabList, samplePanel, true, activeClassNames);
    };

    const onMamKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        setMamActive(tabList, samplePanel, true, activeClassNames);
    };

    const onTabListClick = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const tab = target.closest("[role=\"tab\"]") as HTMLElement | null;
        if (!tab || tab.hasAttribute(MAM_TAB_ATTR)) return;
        setMamActive(tabList, samplePanel, false, activeClassNames);
    };

    mamTab.addEventListener("mousedown", onMamMouseDown, true);
    mamTab.addEventListener("click", onMamClick, true);
    mamTab.addEventListener("keydown", onMamKeyDown, true);
    tabList.addEventListener("click", onTabListClick, true);
    tabList.appendChild(mamTab);

    const cleanup = () => {
        mamTab.removeEventListener("mousedown", onMamMouseDown, true);
        mamTab.removeEventListener("click", onMamClick, true);
        mamTab.removeEventListener("keydown", onMamKeyDown, true);
        tabList.removeEventListener("click", onTabListClick, true);

        const panelContainer = samplePanel.parentElement ?? samplePanel;
        const panels = panelContainer.querySelectorAll<HTMLElement>("[role=\"tabpanel\"]");
        panels.forEach(panelEl => {
            if (panelEl.dataset.vcMamDisplay !== undefined) {
                panelEl.style.display = panelEl.dataset.vcMamDisplay;
                delete panelEl.dataset.vcMamDisplay;
            }
        });

        const mamPanel = panelContainer.querySelector<HTMLElement>(`[${MAM_PANEL_ATTR}]`);
        if (mamPanel) {
            mamRoots.get(mamPanel)?.unmount();
            mamRoots.delete(mamPanel);
            mamPanel.remove();
        }

        mamTab.remove();
        tabList.removeAttribute(MAM_BOUND_ATTR);
        tabList.removeAttribute(MAM_PANEL_ID_ATTR);
        tabList.removeAttribute(MAM_TAB_ID_ATTR);
    };

    cleanupFns.add(cleanup);
}

function scanForPicker() {
    for (const { tabList, sampleTab, samplePanel } of findPickerEntries()) {
        injectMamTab(tabList, sampleTab, samplePanel);
    }
}

async function ensureMamCsp() {
    if (IS_WEB) return;

    const directives = ["connect-src", "img-src"] as const;
    if (await VencordNative.csp.isDomainAllowed(API_BASE_URL, [...directives])) return;

    const res = await VencordNative.csp.requestAddOverride(API_BASE_URL, [...directives], "MAM GIFs");
    if (res === "ok") {
        Alerts.show({
            title: "MAM API enabled",
            body: "midevelopment.de has been added to the whitelist. Please restart the app for the changes to take effect.",
            confirmText: "Restart now",
            cancelText: "Later",
            onConfirm: relaunch
        });
    }
}

export default definePlugin({
    name: "Mag",
    description: "Custom tab in media picker for gifs of the MAM project.",
    authors: [{ name: "Miku", id: 293135882926555137n }, { name: "Ice", id: 788437114583777280n }],
    settings,

    start() {
        void ensureMamCsp();
        observer = new MutationObserver(scanForPicker);
        observer.observe(document.body, { childList: true, subtree: true });
        scanForPicker();
    },

    stop() {
        observer?.disconnect();
        observer = null;

        for (const cleanup of cleanupFns) cleanup();
        cleanupFns.clear();
    }
});
