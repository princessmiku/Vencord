/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { ReplyIcon } from "@components/Icons";
import { sendMessage } from "@utils/discord";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import { findCssClassesLazy } from "@webpack";
import {
    Alerts,
    Button,
    createRoot,
    ExpressionPickerStore,
    React,
    SelectedChannelStore,
    Toasts,
    useCallback,
    useEffect,
    useRef,
    useState
} from "@webpack/common";

/*
 * Configuration constants.  API_BASE_URL points at the upstream
 * service and mirrors the behaviour of the original Mag plugin.  If
 * this constant changes in the future, all HTTP requests will still
 * derive their URLs relative to it.
 */
const MAM_LABEL = "MAM";
const MAM_TAB_ATTR = "data-vc-mam-tab";
const MAM_PANEL_ATTR = "data-vc-mam-panel";
const MAM_BOUND_ATTR = "data-vc-mam-bound";
const MAM_PANEL_ID_ATTR = "data-vc-mam-panel-id";
const MAM_TAB_ID_ATTR = "data-vc-mam-tab-id";
const MAM_OWNER_ATTR = "data-vc-mam-owner";
const API_BASE_URL = "https://www.midevelopment.de/";
const scrollerClasses = findCssClassesLazy("scrollerBase", "thin", "fade");

type MamRoot = { render: (node: React.ReactNode) => void; unmount: () => void; };
type MagGif = {
    id: number;
    public_url: string;
    nsfw?: boolean;
};

/**
 * GIF list entry returned from `/api/gif‑lists`.  Each list has a
 * unique identifier, a display name and a count of GIFs contained in
 * it.  An optional `contains` field exists when the request is
 * performed with the `gif_id` query parameter, but it is not used
 * here.
 */
type GifListEntry = {
    id: number;
    owner_id: number;
    name: string;
    created_at: string;
    gif_count: number;
    contains?: boolean;
};

/**
 * Response format for `/api/gifs` and `/api/gif‑lists/{id}/items`.  The
 * `items` array contains GIF objects and the optional `pagination`
 * object describes pagination state.  Both endpoints share a similar
 * shape so a single type suffices.
 */
type MagResponse = {
    items: MagGif[];
    pagination?: {
        page?: number;
        per_page?: number;
        has_more?: boolean;
        next_page?: number | null;
    };
};

// Lazy getter to handle cases where the native handler might not be ready yet
let nativeHandler: any = null;
function getNative() {
    if (!nativeHandler) {
        nativeHandler = (VencordNative as any).pluginHelpers?.Mag;
    }
    return nativeHandler;
}

const cleanupFns = new Set<() => void>();
const mamRoots = new WeakMap<HTMLElement, MamRoot>();
let observer: MutationObserver | null = null;
let panelIdCounter = 0;

/**
 * Component responsible for rendering the MAM GIF picker.  It has
 * been extended to support user defined lists.  A horizontal bar
 * displays all available lists; selecting a list triggers a fetch
 * against `/api/gif‑lists/{id}/items`.  Selecting "All GIFs" resets
 * the view to the default search across the global catalogue.  When a
 * list is selected the search field becomes disabled to indicate that
 * searching is unavailable in that context.  Pagination continues to
 * function for both modes using the existing "Load more" button.
 */
function MamView() {
    const { apiKey } = settings.use(["apiKey"]);

    // Search related state.  Only used when no list is selected.
    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    // List handling state.
    const [lists, setLists] = useState<GifListEntry[]>([]);
    const [selectedListId, setSelectedListId] = useState<number | null>(null);
    const [viewMode, setViewMode] = useState<"categories" | "all" | "list">("categories");
    const [searchFocused, setSearchFocused] = useState(false);
    const [listsLoading, setListsLoading] = useState(false);
    const [listsError, setListsError] = useState<string | null>(null);
    // A preview image for each list.  Keys correspond to list ids
    // (converted to strings) and 'all' for the global catalogue.  Each
    // value is either a URL to the first GIF in that list or null
    // if no preview is available.  The previews are fetched
    // asynchronously after the lists themselves have been loaded.
    const [listPreviews, setListPreviews] = useState<Record<string, string | null>>({});
    // Results handling state.
    const [items, setItems] = useState<MagGif[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    // Debounce search queries to avoid excessive network calls.
    useEffect(() => {
        const handle = setTimeout(() => setDebouncedQuery(query.trim()), 250);
        return () => clearTimeout(handle);
    }, [query]);

    // Reset pagination whenever the debounced query, API key or selected
    // list changes.  This ensures that a fresh set of results is
    // retrieved when the user switches context.
    useEffect(() => {
        setPage(1);
    }, [debouncedQuery, apiKey, selectedListId, viewMode]);

    // Whenever a search query is entered, switch to the "all" view so
    // results are visible even if the categories grid was shown.
    useEffect(() => {
        if (debouncedQuery !== "" && viewMode !== "all") {
            setViewMode("all");
        }
    }, [debouncedQuery, viewMode]);

    // Fetch the user's lists once the API key is available.  This
    // request runs only when the API key changes.  Any errors are
    // captured in `listsError` and displayed to the user.  The first
    // entry in the bar is always "All GIFs", so an empty array is
    // valid.
    useEffect(() => {
        // If no API key has been provided yet then do not attempt any
        // requests; the main component will display a prompt to set
        // the key.
        if (!apiKey) {
            setLists([]);
            setListsError(null);
            setListsLoading(false);
            return;
        }
        setListsLoading(true);
        setListsError(null);
        const url = new URL("/api/gif-lists", API_BASE_URL);
        // The native handler attaches the API key via an `X-API-Key`
        // header for all requests.  This mirrors the behaviour of the
        // original Mag plugin which communicates with the MAM API.
        Promise.resolve().then(async () => {
            const native = getNative();
            if (native?.fetchMagApi) {
                return native.fetchMagApi(url.toString(), {
                    headers: {
                        "X-API-Key": apiKey
                    }
                });
            }
            throw new Error("Native handler not available. Please ensure you're using Vencord Desktop.");
        }).then(res => {
            if (!res.ok) {
                const message = res.status === 401
                    ? "Invalid API key."
                    : `Request failed (${res.status}).`;
                throw new Error(message);
            }
            // The API returns a plain array of list objects.
            return res.data as GifListEntry[];
        }).then(data => {
            if (Array.isArray(data)) {
                setLists(data);
            } else {
                setLists([]);
            }
        }).catch(err => {
            const message = err instanceof Error ? err.message : "Failed to fetch lists.";
            setListsError(message);
            setLists([]);
        }).finally(() => {
            setListsLoading(false);
        });
    }, [apiKey]);

    // Once lists are loaded, fetch a preview GIF for each list and
    // also for the "All GIFs" pseudo list.  The preview for a list
    // uses the first GIF returned by `/api/gif-lists/<id>/items` with
    // `limit=1`, while the preview for the global catalogue uses the
    // first GIF from `/api/gifs`.
    useEffect(() => {
        // If the API key is not set or lists are not available, clear
        // previews.  A blank object prevents stale previews from
        // appearing when switching accounts.
        if (!apiKey) {
            setListPreviews({});
            return;
        }
        // Use an IIFE to encapsulate async logic within useEffect.
        (async () => {
            const native = getNative();
            if (!native?.fetchMagApi) {
                setListPreviews({});
                return;
            }
            const previews: Record<string, string | null> = {};
            // Helper to fetch the first GIF for a given URL.  Returns
            // the public_url of the first item or null on error.
            const fetchFirstGif = async (url: URL) => {
                try {
                    const res = await native.fetchMagApi(url.toString(), {
                        headers: {
                            "X-API-Key": apiKey
                        }
                    });
                    if (res.ok && Array.isArray(res.data.items) && res.data.items.length > 0) {
                        const gif = res.data.items[0] as MagGif;
                        return gif.public_url;
                    }
                } catch (_) {
                    // ignore errors, return null
                }
                return null;
            };
            // Fetch preview for the global catalogue (key 'all').
            const allUrl = new URL("/api/gifs", API_BASE_URL);
            allUrl.searchParams.set("limit", "1");
            allUrl.searchParams.set("page", "1");
            allUrl.searchParams.set("nsfw", "false");
            allUrl.searchParams.set("visibility", "published");
            previews.all = await fetchFirstGif(allUrl);
            // Fetch preview for each list.  Use list id as string key.
            for (const entry of lists) {
                const url = new URL(`/api/gif-lists/${entry.id}/items`, API_BASE_URL);
                url.searchParams.set("limit", "1");
                url.searchParams.set("page", "1");
                url.searchParams.set("nsfw", "false");
                previews[entry.id.toString()] = await fetchFirstGif(url);
            }
            setListPreviews(previews);
        })();
    }, [lists, apiKey]);

    // Fetch items whenever the API key, search query or list selection
    // changes.  Aborts any ongoing fetch if a new request is issued.
    useEffect(() => {
        // Cancel any previous request.
        abortRef.current?.abort();
        if (viewMode === "categories") {
            setLoading(false);
            return;
        }
        // Without an API key there is no need to continue; display a
        // message prompting the user to set the key.
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
        // Construct the request URL based on whether a list is selected.
        let url: URL;
        if (viewMode === "list" && selectedListId != null) {
            // When a list is selected, fetch its items.  The API uses
            // `/api/gif-lists/<id>/items` and supports pagination and an
            // optional `nsfw` parameter to filter content.  Searching is
            // not supported on list items, so `debouncedQuery` is ignored.
            url = new URL(`/api/gif-lists/${selectedListId}/items`, API_BASE_URL);
            url.searchParams.set("limit", "20");
            url.searchParams.set("page", String(page));
            url.searchParams.set("nsfw", "false");
        } else {
            // Default search across all GIFs.
            url = new URL("/api/gifs", API_BASE_URL);
            if (debouncedQuery) url.searchParams.set("q", debouncedQuery);
            url.searchParams.set("limit", "20");
            url.searchParams.set("page", String(page));
            url.searchParams.set("nsfw", "false");
            url.searchParams.set("visibility", "published");
        }
        Promise.resolve().then(async () => {
            const native = getNative();
            if (native?.fetchMagApi) {
                return native.fetchMagApi(url.toString(), {
                    headers: {
                        "X-API-Key": apiKey
                    }
                });
            }
            throw new Error("Native handler not available. Please ensure you're using Vencord Desktop.");
        }).then(res => {
            if (!res.ok) {
                const message = res.status === 401
                    ? "Invalid API key."
                    : `Request failed (${res.status}).`;
                throw new Error(message);
            }
            return res.data as MagResponse;
        }).then(data => {
            const nextItems = Array.isArray(data.items) ? data.items : [];
            setItems(prev => page === 1 ? nextItems : [...prev, ...nextItems]);
            const hasMoreFromFlag = typeof data.pagination?.has_more === "boolean"
                ? data.pagination?.has_more
                : null;
            const hasMoreFromNext = data.pagination?.next_page != null;
            setHasMore(hasMoreFromFlag ?? hasMoreFromNext);
        }).catch(err => {
            if (controller.signal.aborted) return;
            const message = err instanceof Error ? err.message : "Request failed.";
            setError(message);
            // Preserve previous results if paginating; otherwise clear.
            setItems(prev => page === 1 ? [] : prev);
            setHasMore(false);
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [apiKey, debouncedQuery, selectedListId, page, viewMode]);

    // Handler invoked when the user clicks on a GIF to send it to the
    // currently selected channel.  If no channel is selected a toast
    // informs the user accordingly.
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

    // Determine whether to display the category selection grid.  The
    // grid appears when no list is currently selected and the user
    // has not entered a search query.  This replicates the Tenor
    // category view in Discord's GIF picker.
    const showCategories = viewMode === "categories";

    // Render a grid of category cards.  Each card corresponds to
    // either the global catalogue (id null) or one of the user's
    // lists.  Cards display a preview image when available and
    // overlay the list name.  Clicking a card selects that list and
    // resets the search query.
    function renderCategoryGrid() {
        if (listsLoading) {
            return <div style={{ gridColumn: "1 / -1", padding: "8px", opacity: 0.7 }}>Loading lists…</div>;
        }
        if (listsError) {
            return <div style={{ gridColumn: "1 / -1", padding: "8px", color: "var(--status-danger)" }}>{listsError}</div>;
        }
        // Assemble an array of category entries.  Use 'all' for the
        // global catalogue key to look up its preview.
        const entries: Array<{ id: number | null; name: string; key: string; }> = [
            { id: null, name: "Alle GIFs", key: "all" },
            ...lists.map(l => ({ id: l.id, name: l.name, key: l.id.toString() }))
        ];
        return entries.map(entry => {
            const active = (viewMode === "all" && entry.id === null)
                || (viewMode === "list" && selectedListId === entry.id);
            const previewUrl = listPreviews[entry.key] ?? null;
            return (
                <button
                    key={entry.key}
                    onClick={() => {
                        setQuery("");
                        if (entry.id === null) {
                            setSelectedListId(null);
                            setViewMode("all");
                        } else {
                            setSelectedListId(entry.id);
                            setViewMode("list");
                        }
                    }}
                    style={{
                        position: "relative",
                        border: "none",
                        padding: 0,
                        background: "transparent",
                        borderRadius: 6,
                        cursor: "pointer",
                        overflow: "hidden",
                        height: 100
                    }}
                    aria-label={entry.name}
                    title={entry.name}
                >
                    {previewUrl ? (
                        <img
                            src={previewUrl}
                            loading="lazy"
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                    ) : (
                        <div style={{ width: "100%", height: "100%", backgroundColor: "var(--background-tertiary)" }} />
                    )}
                    {/* Overlay to darken the preview and highlight the active card */}
                    <div
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: active ? "rgba(255, 255, 255, 0.25)" : "rgba(0, 0, 0, 0.35)",
                            transition: "background-color 0.2s"
                        }}
                    />
                    {/* Category label centred on the card */}
                    <div
                        style={{
                            position: "absolute",
                            top: "50%",
                            left: "50%",
                            transform: "translate(-50%, -50%)",
                            color: "white",
                            fontWeight: "bold",
                            textShadow: "0 0 4px rgba(0,0,0,0.8)",
                            pointerEvents: "none"
                        }}
                    >
                        {entry.name}
                    </div>
                </button>
            );
        });
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            {/* Search bar */}
            <div style={{ padding: "8px 12px", display: "flex", gap: 8, alignItems: "center" }}>
                {viewMode !== "categories" ? (
                    <Button
                        size={Button.Sizes.SMALL}
                        aria-label="Zurück"
                        onClick={() => {
                            setQuery("");
                            setSelectedListId(null);
                            setViewMode("categories");
                        }}
                    >
                        <ReplyIcon width={18} height={18} />
                    </Button>
                ) : null}
                {viewMode !== "list" ? (
                    <div
                        style={{
                            flex: 1,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            height: 32,
                            padding: "0 10px",
                            borderRadius: 16,
                            backgroundColor: "var(--background-secondary)",
                            border: "1px solid var(--background-tertiary)",
                            boxShadow: searchFocused ? "0 0 0 2px var(--brand-500)" : "none",
                            transition: "box-shadow 0.15s ease, border-color 0.15s ease"
                        }}
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            role="img"
                            aria-hidden="true"
                            style={{ color: "var(--text-muted)", flex: "0 0 auto" }}
                        >
                            <path
                                fill="currentColor"
                                d="M10.5 3a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm8.85 12.44 3.2 3.2a1 1 0 0 1-1.42 1.42l-3.2-3.2a1 1 0 0 1 1.42-1.42Z"
                            />
                        </svg>
                        <input
                            value={query}
                            placeholder="GIFs durchsuchen"
                            onChange={event => setQuery(event.currentTarget.value)}
                            onKeyDown={event => {
                                if (event.key === "Enter") setPage(1);
                            }}
                            onFocus={() => setSearchFocused(true)}
                            onBlur={() => setSearchFocused(false)}
                            aria-label="GIFs durchsuchen"
                            style={{
                                flex: 1,
                                height: "100%",
                                background: "transparent",
                                border: "none",
                                color: "var(--input-text-default)",
                                fontSize: 14,
                                outline: "none"
                            }}
                        />
                        {query ? (
                            <button
                                onClick={() => setQuery("")}
                                aria-label="Suche löschen"
                                style={{
                                    border: "none",
                                    background: "transparent",
                                    color: "var(--text-muted)",
                                    cursor: "pointer",
                                    padding: 0,
                                    fontSize: 16,
                                    lineHeight: 1
                                }}
                            >
                                ×
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {error ? (
                <div style={{ padding: "0 12px 8px", color: "var(--status-danger)" }}>
                    {error}
                </div>
            ) : null}

            {/* Content area: either category grid or GIF grid */}
            <div style={{ flex: 1, overflow: "auto" }} className={`${scrollerClasses.scrollerBase} ${scrollerClasses.thin} ${scrollerClasses.fade}`}>
                <div style={{ padding: "8px 16px 12px" }}>
                    {showCategories ? (
                        <div
                            style={{
                                display: "grid",
                                gap: 8,
                                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))"
                            }}
                        >
                            {renderCategoryGrid()}
                        </div>
                    ) : (
                        <div
                            style={{
                                columnWidth: 140,
                                columnGap: 8,
                                width: "100%"
                            }}
                        >
                            {!loading && !error && items.length === 0 ? (
                                <div style={{ width: "100%", display: "block", opacity: 0.7 }}>
                                    {selectedListId === null ? "No results." : "No items in this list."}
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
                                        cursor: "pointer",
                                        display: "inline-block",
                                        width: "100%",
                                        marginBottom: 8,
                                        breakInside: "avoid"
                                    }}
                                    aria-label="Send GIF"
                                    title="Send GIF"
                                >
                                    <img
                                        src={gif.public_url}
                                        loading="lazy"
                                        style={{
                                            display: "block",
                                            width: "100%",
                                            height: "auto",
                                            objectFit: "cover",
                                            borderRadius: 6
                                        }}
                                    />
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Pagination controls: only show when viewing GIF grid */}
            {!showCategories ? (
                <div style={{ display: "flex", justifyContent: "center", padding: "8px 12px 12px", gap: 8 }}>
                    {loading ? <div>Loading...</div> : null}
                    {!loading && hasMore ? (
                        <Button size={Button.Sizes.SMALL} onClick={() => setPage(p => p + 1)}>
                            Load more
                        </Button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

// Plugin settings definition.  Reuse the existing API key field to authenticate
// against the new endpoints.  No new settings are introduced.
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
    const panels = document.querySelectorAll<HTMLElement>("[id$=\"picker-tab-panel\"], [id*='picker-tab-panel']");
    for (const panel of panels) {
        const tab = document.querySelector<HTMLElement>(`[role="tab"][aria-controls="${panel.id}"]`)
            ?? document.querySelector<HTMLElement>(`[aria-controls="${panel.id}"]`);
        if (!tab) continue;
        const tabList = tab.closest<HTMLElement>("[role='tablist']") ?? tab.parentElement;
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
    const activeTab = tabList.querySelector<HTMLElement>("[role='tab'][aria-selected='true'], [role='tab'][aria-current='page']")
        ?? tabList.querySelector<HTMLElement>("[role='tab']:not([data-vc-mam-tab])")
        ?? tabList.querySelector<HTMLElement>("[role='tab']");
    const panelId = activeTab?.getAttribute("aria-controls");
    if (panelId) {
        const panel = document.getElementById(panelId);
        if (panel) return panel as HTMLElement;
    }
    if (fallback?.isConnected) return fallback;
    const tabs = tabList.querySelectorAll<HTMLElement>("[role='tab'][aria-controls]");
    for (const tab of tabs) {
        const id = tab.getAttribute("aria-controls");
        if (!id) continue;
        const panel = document.getElementById(id);
        if (panel) return panel as HTMLElement;
    }
    return null;
}

function getActiveClassNames(tabList: HTMLElement, sampleTab: HTMLElement) {
    const activeTab = tabList.querySelector<HTMLElement>("[role='tab'][aria-selected='true'], [role='tab'][aria-current='page']")
        ?? sampleTab;
    const inactiveTab = tabList.querySelector<HTMLElement>("[role='tab']:not([aria-selected='true']):not([aria-current='page'])");
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
    const orphanPanels = document.querySelectorAll<HTMLElement>(`[${MAM_PANEL_ATTR}][${MAM_OWNER_ATTR}='${panelId}']`);
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
        mamPanel.style.overflow = "hidden";
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
    const panels = panelContainer.querySelectorAll<HTMLElement>("[role='tabpanel']");
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
            const otherTabs = tabList.querySelectorAll<HTMLElement>("[role='tab']");
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
        const tab = target.closest("[role='tab']") as HTMLElement | null;
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
        const panels = panelContainer.querySelectorAll<HTMLElement>("[role='tabpanel']");
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
    description: "Custom tab in media picker for gifs of the MAM project with list support.",
    authors: [
        { name: "Miku", id: 293135882926555137n },
        { name: "Ice", id: 788437114583777280n }
    ],
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
