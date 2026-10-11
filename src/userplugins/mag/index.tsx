/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { ReplyIcon } from "@components/Icons";
import { sendMessage } from "@utils/discord";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import { findCssClassesLazy, findStoreLazy } from "@webpack";
import {
    Alerts,
    Button,
    ComponentDispatch,
    createRoot,
    ExpressionPickerStore,
    FluxDispatcher,
    MessageActions,
    React,
    SelectedChannelStore,
    showToast,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "@webpack/common";

const MAM_LABEL = "MAM";
const MAM_TAB_ATTR = "data-vc-mam-tab";
const MAM_PANEL_ATTR = "data-vc-mam-panel";
const MAM_BOUND_ATTR = "data-vc-mam-bound";
const MAM_PANEL_ID_ATTR = "data-vc-mam-panel-id";
const MAM_TAB_ID_ATTR = "data-vc-mam-tab-id";
const MAM_OWNER_ATTR = "data-vc-mam-owner";
const API_BASE_URL = "https://api.midevelopment.de/";
const scrollerClasses = findCssClassesLazy("scrollerBase", "thin", "fade");
const PendingReplyStore = findStoreLazy("PendingReplyStore");

type MamRoot = { render: (node: React.ReactNode) => void; unmount: () => void };
type MagGif = {
    id: number;
    public_url: string;
    nsfw?: boolean;
};

type GifListEntry = {
    id: number;
    owner_id: number;
    name: string;
    created_at: string;
    gif_count: number;
    contains?: boolean;
};

type MagResponse = {
    items: MagGif[];
    pagination?: {
        page?: number;
        per_page?: number;
        has_more?: boolean;
        next_page?: number | null;
    };
};

// Vencord registers native handlers under the plugin's *folder* name as key
// in VencordNative.pluginHelpers.  Try the canonical name first, then fall
// back to a case-insensitive search so minor naming mismatches don't break
// everything.
let nativeHandler: any = null;

function getNative() {
    if (nativeHandler) return nativeHandler;

    const helpers = (VencordNative as any).pluginHelpers;
    if (!helpers) return null;

    const knownKeys = ["MAG", "Mag", "mag", "MAM", "Mam", "mam"];

    for (const key of knownKeys) {
        const mod = helpers[key];
        if (mod && typeof mod.fetchMagApi === "function") {
            console.log("[MAM] Using native handler:", key);
            nativeHandler = mod;
            return nativeHandler;
        }
    }

    for (const key of Object.keys(helpers)) {
        const mod = helpers[key];
        if (mod && typeof mod.fetchMagApi === "function") {
            console.log("[MAM] Using native handler:", key);
            nativeHandler = mod;
            return nativeHandler;
        }
    }

    console.error("[MAM] Native handler not found. Available helpers:", Object.keys(helpers));
    return null;
}

async function fetchMagApi(url: string, options: RequestInit & { headers?: Record<string, string> } = {}) {
    const native = getNative();

    if (!native || typeof native.fetchMagApi !== "function") {
        throw new Error("MAM native handler not found.");
    }

    try {
        const res = await native.fetchMagApi(url, options);

        if (!res) {
            throw new Error("Empty response from native handler.");
        }

        return res;
    } catch (err) {
        console.error("[MAM] Native request failed:", err);
        throw err;
    }
}

async function trackGifSend(gifId: number, query: string, apiKey: string) {
    const headers = {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
    };

    const shareUrl = new URL(`/api/gifs/${gifId}/share`, API_BASE_URL);
    const requests = [
        fetchMagApi(shareUrl.toString(), {
            method: "POST",
            headers,
        }),
    ];

    if (query) {
        const analyticsUrl = new URL("/api/gifs/query/analytics", API_BASE_URL);
        requests.push(
            fetchMagApi(analyticsUrl.toString(), {
                method: "POST",
                headers,
                body: JSON.stringify({ query, gif_id: gifId }),
            }),
        );
    }

    const results = await Promise.allSettled(requests);

    for (const result of results) {
        if (result.status === "rejected") {
            console.error("[MAM] GIF tracking request failed:", result.reason);
        } else if (!result.value.ok) {
            console.error("[MAM] GIF tracking request failed:", result.value.status);
        }
    }
}

const cleanupFns = new Map<HTMLElement, () => void>();
const mamRoots = new Map<HTMLElement, MamRoot>();
let observer: MutationObserver | null = null;
let panelIdCounter = 0;
let scanFrame = 0;
let openMamUntil = 0;

interface MasonryGridProps {
    items: MagGif[];
    onSend: (gif: MagGif) => void;
    columnWidth?: number;
    gap?: number;
}

function MasonryGrid({ items, onSend, columnWidth = 140, gap = 8 }: MasonryGridProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const columnRefs = useRef<HTMLDivElement[]>([]);
    const columnHeightsRef = useRef<number[]>([]);
    const queuedIdsRef = useRef(new Set<number>());
    const generationRef = useRef(0);
    const onSendRef = useRef(onSend);
    const [columnCount, setColumnCount] = useState(3);
    onSendRef.current = onSend;

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const resizeObserver = new ResizeObserver(entries => {
            const { width } = entries[0].contentRect;
            if (width > 0) setColumnCount(Math.max(1, Math.floor((width + gap) / (columnWidth + gap))));
        });
        resizeObserver.observe(container);
        return () => resizeObserver.disconnect();
    }, [columnWidth, gap]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        container.replaceChildren();
        columnRefs.current = [];
        columnHeightsRef.current = [];
        queuedIdsRef.current.clear();
        for (let index = 0; index < columnCount; index++) {
            const column = document.createElement("div");
            column.style.cssText = `display:flex;flex-direction:column;gap:${gap}px;flex:1 1 0;min-width:0;`;
            container.appendChild(column);
            columnRefs.current.push(column);
            columnHeightsRef.current.push(0);
        }
        return () => {
            generationRef.current++;
            container.replaceChildren();
        };
    }, [columnCount, gap]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const columns = columnRefs.current;
        if (!container || !columns.length) return;
        const generation = generationRef.current;
        const width = container.clientWidth > 0
            ? (container.clientWidth - gap * (columns.length - 1)) / columns.length
            : columnWidth;

        for (const gif of items) {
            if (queuedIdsRef.current.has(gif.id)) continue;
            queuedIdsRef.current.add(gif.id);
            const shortestIndex = columnHeightsRef.current.indexOf(Math.min(...columnHeightsRef.current));
            const column = columns[shortestIndex];
            columnHeightsRef.current[shortestIndex] += width + gap;

            const button = document.createElement("button");
            button.type = "button";
            button.style.cssText = "border:none;padding:0;background:var(--background-tertiary);cursor:pointer;display:block;width:100%;border-radius:6px;overflow:hidden;content-visibility:auto;contain-intrinsic-size:auto 140px;";
            button.setAttribute("aria-label", "Send GIF");
            button.title = "Send GIF";
            const img = document.createElement("img");
            img.alt = "";
            img.loading = "lazy";
            img.decoding = "async";
            img.style.cssText = "display:block;width:100%;height:auto;aspect-ratio:1;";
            let measuredHeight = width;
            img.onload = () => {
                if (generation !== generationRef.current || !img.naturalWidth) return;
                img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
                img.alt = "";
                button.title = "Send GIF";
                const height = width * img.naturalHeight / img.naturalWidth;
                columnHeightsRef.current[shortestIndex] += height - measuredHeight;
                measuredHeight = height;
            };
            img.onerror = () => {
                if (generation !== generationRef.current) return;
                img.alt = "Vorschau nicht verfügbar";
                button.title = "Vorschau erneut laden";
            };
            button.addEventListener("click", () => {
                if (!img.naturalWidth) {
                    img.src = gif.public_url;
                } else {
                    onSendRef.current(gif);
                }
            });
            img.src = gif.public_url;
            button.appendChild(img);
            column.appendChild(button);
        }
    }, [items, columnCount, columnWidth, gap]);

    return <div ref={containerRef} style={{ display: "flex", gap, width: "100%", alignItems: "flex-start" }} />;
}

// ---------------------------------------------------------------------------
// MamView
// ---------------------------------------------------------------------------

function MamView() {
    const { apiKey } = settings.use(["apiKey"]);
    const normalizedApiKey = apiKey.trim();

    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [lists, setLists] = useState<GifListEntry[]>([]);
    const [selectedListId, setSelectedListId] = useState<number | null>(null);
    const [viewMode, setViewMode] = useState<"categories" | "all" | "list">("categories");
    const [searchFocused, setSearchFocused] = useState(false);
    const [listsLoading, setListsLoading] = useState(true);
    const [listsError, setListsError] = useState<string | null>(null);
    const [listPreviews, setListPreviews] = useState<Record<string, string | null>>({});
    const [items, setItems] = useState<MagGif[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [initialLoading, setInitialLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const loadNextRef = useRef<(() => void) | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const loadingMoreRef = useRef(false);
    // The scroll container itself — needed to attach the scroll listener.
    const scrollerRef = useRef<HTMLDivElement>(null);

    // Debounce search queries.
    useEffect(() => {
        const handle = setTimeout(() => setDebouncedQuery(query.trim()), 250);
        return () => clearTimeout(handle);
    }, [query]);

    // Auto-switch to "all" view when the user starts typing.
    useEffect(() => {
        if (debouncedQuery !== "" && viewMode !== "all") {
            setViewMode("all");
        }
    }, [debouncedQuery]);

    // Fetch user's GIF lists.
    useEffect(() => {
        if (!normalizedApiKey) {
            setLists([]);
            setListsError(null);
            setListsLoading(false);
            return;
        }
        let cancelled = false;
        setListsLoading(true);
        setListsError(null);
        const url = new URL("/api/gif-lists", API_BASE_URL);
        fetchMagApi(url.toString(), { headers: { "X-API-Key": normalizedApiKey } })
            .then(res => {
                if (!res.ok)
                    throw new Error(res.status === 401 ? "Invalid API key." : `Request failed (${res.status}).`);
                return res.data as GifListEntry[];
            })
            .then(data => {
                if (!cancelled) setLists(Array.isArray(data) ? data : []);
            })
            .catch(err => {
                if (cancelled) return;
                setListsError(err instanceof Error ? err.message : "Failed to fetch lists.");
                setLists([]);
            })
            .finally(() => {
                if (!cancelled) setListsLoading(false);
            });
        return () => { cancelled = true; };
    }, [normalizedApiKey]);

    useEffect(() => {
        let cancelled = false;
        setListPreviews({});
        if (!normalizedApiKey || listsLoading || listsError) return;
        const entries = [{ id: null, key: "all" }, ...lists.map(entry => ({ id: entry.id, key: String(entry.id) }))];
        const worker = async () => {
            while (!cancelled && entries.length) {
                const entry = entries.shift()!;
                const url = new URL(entry.id === null ? "/api/gifs" : `/api/gif-lists/${entry.id}/items`, API_BASE_URL);
                url.searchParams.set("limit", "1");
                url.searchParams.set("page", "1");
                url.searchParams.set("nsfw", "false");
                if (entry.id === null) url.searchParams.set("visibility", "published");
                try {
                    const res = await fetchMagApi(url.toString(), { headers: { "X-API-Key": normalizedApiKey } });
                    const preview = res.ok ? res.data?.items?.[0]?.public_url ?? null : null;
                    if (!cancelled) setListPreviews(previous => ({ ...previous, [entry.key]: preview }));
                } catch {
                    if (!cancelled) setListPreviews(previous => ({ ...previous, [entry.key]: null }));
                }
            }
        };
        void Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
        return () => { cancelled = true; };
    }, [lists, listsLoading, listsError, normalizedApiKey]);

    useEffect(() => {
        let cancelled = false;
        let nextPage = 1;
        let pending = false;
        const limit = 30;
        setItems([]);
        setError(null);
        setHasMore(false);
        setInitialLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
        scrollerRef.current?.scrollTo(0, 0);
        loadNextRef.current = null;
        if (!normalizedApiKey) {
            setError("Set your MAM API key in the plugin settings.");
            return;
        }
        if (viewMode === "categories") return;

        const loadPage = async () => {
            if (cancelled || pending) return;
            pending = true;
            loadingMoreRef.current = true;
            const requestedPage = nextPage;
            const isPaginating = requestedPage > 1;
            setInitialLoading(!isPaginating);
            setLoadingMore(isPaginating);
            setError(null);
            const url = new URL(viewMode === "list" && selectedListId != null
                ? `/api/gif-lists/${selectedListId}/items`
                : "/api/gifs", API_BASE_URL);
            url.searchParams.set("limit", String(limit));
            url.searchParams.set("page", String(requestedPage));
            url.searchParams.set("nsfw", "false");
            if (viewMode === "all") {
                if (debouncedQuery) url.searchParams.set("q", debouncedQuery);
                url.searchParams.set("visibility", "published");
            }
            try {
                const res = await fetchMagApi(url.toString(), { headers: { "X-API-Key": normalizedApiKey } });
                if (cancelled) return;
                if (!res.ok) throw new Error(res.status === 401 ? "Invalid API key." : `Request failed (${res.status}).`);
                const data = res.data as MagResponse;
                if (!Array.isArray(data?.items)) throw new Error("Invalid GIF response.");
                const nextItems = data.items;
                setItems(previous => {
                    const unique = new Map(previous.map(gif => [gif.id, gif]));
                    for (const gif of nextItems) unique.set(gif.id, gif);
                    return [...unique.values()];
                });
                const serverNext = data.pagination?.next_page;
                const more = nextItems.length > 0 && (data.pagination?.has_more
                    ?? (serverNext !== undefined ? serverNext !== null : nextItems.length >= limit));
                nextPage = typeof serverNext === "number" && Number.isInteger(serverNext) && serverNext > requestedPage
                    ? serverNext : requestedPage + 1;
                setHasMore(more);
                if (!more) loadNextRef.current = null;
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "Request failed.");
            } finally {
                if (!cancelled) {
                    pending = false;
                    loadingMoreRef.current = false;
                    setInitialLoading(false);
                    setLoadingMore(false);
                }
            }
        };
        loadNextRef.current = () => { void loadPage(); };
        void loadPage();
        return () => {
            cancelled = true;
            loadNextRef.current = null;
        };
    }, [normalizedApiKey, debouncedQuery, selectedListId, viewMode]);

    useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller || viewMode === "categories" || error) return;
        const check = () => {
            if (!hasMore || loadingMoreRef.current || initialLoading || !scroller.clientHeight) return;
            const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
            if (distanceFromBottom < Math.max(1200, scroller.clientHeight * 2)) loadNextRef.current?.();
        };
        const resizeObserver = new ResizeObserver(check);
        resizeObserver.observe(scroller);
        if (scroller.firstElementChild) resizeObserver.observe(scroller.firstElementChild);
        scroller.addEventListener("scroll", check, { passive: true });
        check();
        return () => {
            resizeObserver.disconnect();
            scroller.removeEventListener("scroll", check);
        };
    }, [hasMore, initialLoading, loadingMore, items, viewMode, error]);

    const onSend = useCallback(
        (gif: MagGif) => {
            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId) {
                showToast("No channel selected.", "failure");
                return;
            }
            const reply = PendingReplyStore.getPendingReply(channelId);
            const replyOptions = reply ? MessageActions.getSendMessageOptionsForReply(reply) : undefined;
            void sendMessage(channelId, { content: gif.public_url }, true, replyOptions ?? {}).then(() => {
                if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
                void trackGifSend(gif.id, debouncedQuery, normalizedApiKey);
            }).catch(() => {
                showToast("GIF could not be sent.", "failure");
            });
            ExpressionPickerStore.closeExpressionPicker();
        },
        [debouncedQuery, normalizedApiKey],
    );

    const showCategories = viewMode === "categories";

    function renderCategoryGrid() {
        if (listsLoading)
            return <div style={{ gridColumn: "1 / -1", padding: "8px", opacity: 0.7 }}>Loading lists…</div>;
        if (listsError)
            return (
                <div style={{ gridColumn: "1 / -1", padding: "8px", color: "var(--status-danger)" }}>{listsError}</div>
            );
        const entries: Array<{ id: number | null; name: string; key: string }> = [
            { id: null, name: "Alle GIFs", key: "all" },
            ...lists.map(l => ({ id: l.id, name: l.name, key: l.id.toString() })),
        ];
        return entries.map(entry => {
            const active =
                (viewMode === "all" && entry.id === null) || (viewMode === "list" && selectedListId === entry.id);
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
                        height: 100,
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
                    <div
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: active ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.35)",
                            transition: "background-color 0.2s",
                        }}
                    />
                    <div
                        style={{
                            position: "absolute",
                            top: "50%",
                            left: "50%",
                            transform: "translate(-50%,-50%)",
                            color: "white",
                            fontWeight: "bold",
                            textShadow: "0 0 4px rgba(0,0,0,0.8)",
                            pointerEvents: "none",
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
                            transition: "box-shadow 0.15s ease, border-color 0.15s ease",
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
                                if (event.key === "Enter") setDebouncedQuery(query.trim());
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
                                outline: "none",
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
                                    lineHeight: 1,
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
                    {normalizedApiKey && !showCategories ? (
                        <Button size={Button.Sizes.SMALL} onClick={() => loadNextRef.current?.()}>Erneut versuchen</Button>
                    ) : null}
                </div>
            ) : null}

            {/* Content area */}
            <div
                ref={scrollerRef}
                style={{ flex: 1, minHeight: 0, overflow: "auto" }}
                className={`${scrollerClasses.scrollerBase} ${scrollerClasses.thin} ${scrollerClasses.fade}`}
            >
                <div style={{ padding: "8px 16px 12px" }}>
                    {showCategories ? (
                        <div
                            style={{
                                display: "grid",
                                gap: 8,
                                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                            }}
                        >
                            {renderCategoryGrid()}
                        </div>
                    ) : initialLoading ? (
                        <div style={{ opacity: 0.7, padding: "8px 0" }}>Loading…</div>
                    ) : (
                        <>
                            {!error && items.length === 0 ? (
                                <div style={{ opacity: 0.7 }}>
                                    {selectedListId === null ? "No results." : "No items in this list."}
                                </div>
                            ) : (
                                <MasonryGrid items={items} onSend={onSend} />
                            )}
                            {/* Subtle loading indicator while fetching the next batch */}
                            {loadingMore ? (
                                <div style={{ textAlign: "center", padding: "8px 0 4px", opacity: 0.5, fontSize: 12 }}>
                                    Loading…
                                </div>
                            ) : null}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Plugin settings
// ---------------------------------------------------------------------------

const settings = definePluginSettings({
    apiKey: {
        type: OptionType.STRING,
        description: "MAM API key",
        default: "",
    },
});

// ---------------------------------------------------------------------------
// Chat bar button
// ---------------------------------------------------------------------------

const MamIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
    </svg>
);

const MamChatBarButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    const handleClick = () => {
        ComponentDispatch.dispatch("TOGGLE_GIF_PICKER");
        openMamUntil = Date.now() + 1500;
        schedulePickerScan();
    };
    return (
        <ChatBarButton tooltip="MAM GIFs" onClick={handleClick}>
            <MamIcon />
        </ChatBarButton>
    );
};

// ---------------------------------------------------------------------------
// Picker injection helpers (unchanged from original)
// ---------------------------------------------------------------------------

function findPickerEntries() {
    const entries: Array<{ tabList: HTMLElement; sampleTab: HTMLElement; samplePanel: HTMLElement }> = [];
    const seen = new Set<HTMLElement>();
    const panels = document.querySelectorAll<HTMLElement>("[id$=\"picker-tab-panel\"], [id*='picker-tab-panel']");
    for (const panel of panels) {
        if (panel.hasAttribute(MAM_PANEL_ATTR)) continue;
        const tab =
            document.querySelector<HTMLElement>(`[role="tab"][aria-controls="${panel.id}"]`) ??
            document.querySelector<HTMLElement>(`[aria-controls="${panel.id}"]`);
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
    const activeTab =
        tabList.querySelector<HTMLElement>("[role='tab'][aria-selected='true']:not([data-vc-mam-tab]), [role='tab'][aria-current='page']:not([data-vc-mam-tab])") ??
        tabList.querySelector<HTMLElement>("[role='tab']:not([data-vc-mam-tab])") ??
        tabList.querySelector<HTMLElement>("[role='tab']");
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
    const activeTab =
        tabList.querySelector<HTMLElement>("[role='tab'][aria-selected='true'], [role='tab'][aria-current='page']") ??
        sampleTab;
    const inactiveTab = tabList.querySelector<HTMLElement>(
        "[role='tab']:not([aria-selected='true']):not([aria-current='page'])",
    );
    if (!activeTab) return [] as string[];
    if (!inactiveTab) return Array.from(activeTab.classList).filter(n => n.toLowerCase().includes("active"));
    const inactive = new Set(inactiveTab.classList);
    return Array.from(activeTab.classList).filter(n => !inactive.has(n));
}

function setTabActiveState(tab: HTMLElement, active: boolean, activeClassNames: string[]) {
    tab.setAttribute("aria-selected", active ? "true" : "false");
    if (active) {
        tab.setAttribute("aria-current", "page");
        tab.tabIndex = 0;
        activeClassNames.forEach(n => tab.classList.add(n));
    } else {
        tab.removeAttribute("aria-current");
        tab.tabIndex = -1;
        activeClassNames.forEach(n => tab.classList.remove(n));
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
    const { panelId } = getMamIds(tabList);
    const mamPanel = active ? ensureMamPanel(resolvedPanel, panelId) : document.getElementById(panelId);
    if (!mamPanel) return;
    const panelContainer = resolvedPanel.parentElement ?? resolvedPanel;
    const panels = panelContainer.querySelectorAll<HTMLElement>("[role='tabpanel']");
    panels.forEach(panel => {
        if (panel === mamPanel) return;
        if (active) {
            if (panel.dataset.vcMamDisplay === undefined) panel.dataset.vcMamDisplay = panel.style.display;
            if (panel.dataset.vcMamHidden === undefined)
                panel.dataset.vcMamHidden = panel.hasAttribute("hidden") ? "1" : "0";
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
                if (tab !== mamTab) setTabActiveState(tab, false, activeClassNames);
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
        requestAnimationFrame(() => {
            if (tabList.isConnected && tabList.hasAttribute(MAM_BOUND_ATTR)) {
                setMamActive(tabList, samplePanel, true, activeClassNames);
            }
        });
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
        const tab = (event.target as HTMLElement | null)?.closest("[role='tab']") as HTMLElement | null;
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
        panelContainer.querySelectorAll<HTMLElement>("[role='tabpanel']").forEach(panelEl => {
            if (panelEl.dataset.vcMamDisplay !== undefined) {
                panelEl.style.display = panelEl.dataset.vcMamDisplay;
                delete panelEl.dataset.vcMamDisplay;
            }
            if (panelEl.dataset.vcMamHidden !== undefined) {
                if (panelEl.dataset.vcMamHidden === "1") panelEl.setAttribute("hidden", "");
                else panelEl.removeAttribute("hidden");
                delete panelEl.dataset.vcMamHidden;
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
        cleanupFns.delete(tabList);
    };
    cleanupFns.set(tabList, cleanup);
}

function scanForPicker() {
    for (const [tabList, cleanup] of cleanupFns) {
        if (!tabList.isConnected) cleanup();
    }
    for (const [panel, root] of mamRoots) {
        if (!panel.isConnected) {
            root.unmount();
            mamRoots.delete(panel);
        }
    }
    for (const { tabList, sampleTab, samplePanel } of findPickerEntries()) {
        injectMamTab(tabList, sampleTab, samplePanel);
        if (Date.now() < openMamUntil) {
            openMamUntil = 0;
            setMamActive(tabList, samplePanel, true, getActiveClassNames(tabList, sampleTab));
        }
    }
}

function schedulePickerScan() {
    if (scanFrame) return;
    scanFrame = requestAnimationFrame(() => {
        scanFrame = 0;
        scanForPicker();
    });
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
            onConfirm: relaunch,
        });
    }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePlugin({
    name: "MAG",
    description: "Custom tab in media picker for gifs of the MAM project with list support.",
    authors: [
        { name: "Miku", id: 293135882926555137n },
        { name: "Ice", id: 788437114583777280n },
    ],
    settings,
    chatBarButton: {
        icon: MamIcon,
        render: MamChatBarButton,
    },
    start() {
        void ensureMamCsp();
        // Log available native plugin helpers so we can verify the handler key.
        console.log("[Mag] pluginHelpers keys:", Object.keys((VencordNative as any).pluginHelpers ?? {}));
        observer = new MutationObserver(records => {
            if (records.some(record => !(record.target instanceof Element && record.target.closest(`[${MAM_PANEL_ATTR}]`)))) {
                schedulePickerScan();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        scanForPicker();
    },
    stop() {
        observer?.disconnect();
        observer = null;
        cancelAnimationFrame(scanFrame);
        scanFrame = 0;
        openMamUntil = 0;
        for (const cleanup of cleanupFns.values()) cleanup();
        cleanupFns.clear();
        for (const [panel, root] of mamRoots) {
            root.unmount();
            panel.remove();
        }
        mamRoots.clear();
        nativeHandler = null;
    },
});
