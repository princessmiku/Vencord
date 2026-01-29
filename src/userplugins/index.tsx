/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { getCurrentChannel, sendMessage } from "@utils/discord";
import { closeModal, ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { IconComponent, OptionType, StartAt } from "@utils/types";
import { Button, Forms, TextInput, useCallback, useEffect, useMemo, useRef, useState } from "@webpack/common";

interface GifItem {
    id: number;
    public_url: string;
    nsfw: boolean;
    published: boolean;
    created_at: string;
}

interface GifList {
    id: number;
    name: string;
    gif_count: number;
}

interface Pagination {
    page: number;
    per_page: number;
    has_more: boolean;
    next_page: number | null;
}

interface GifListResponse {
    items: GifItem[];
    pagination: Pagination;
}

interface GifSearchResponse extends GifListResponse { }

const settings = definePluginSettings({
    apiKey: {
        type: OptionType.STRING,
        description: "MyAnimeManager API key used for authenticated GIF access",
        default: "",
    },
    baseUrl: {
        type: OptionType.STRING,
        description: "Base URL for MyAnimeManager (production). Debug mode overrides this.",
        default: "https://www.midevelopment.de/",
    },
    useLocalDebug: {
        type: OptionType.BOOLEAN,
        description: "Route requests to the local backend (http://127.0.0.1:8000)",
        default: false,
    },
});

const SEARCH_LIMIT = 30;
const LIST_LIMIT = 20;

function resolveBaseUrl(baseUrl: string, useLocalDebug: boolean) {
    const raw = useLocalDebug ? "http://127.0.0.1:8000" : (baseUrl || "https://www.midevelopment.de/");
    return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function buildUrl(baseUrl: string, path: string, params?: Record<string, string | number | boolean | undefined>) {
    const url = new URL(path, baseUrl);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === "") continue;
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

async function parseErrorResponse(res: Response) {
    try {
        const json = await res.json();
        if (json?.detail) return String(json.detail);
    } catch { }
    try {
        return await res.text();
    } catch { }
    return `Request failed (${res.status})`;
}

async function apiGet<T>(baseUrl: string, apiKey: string, path: string, params?: Record<string, string | number | boolean | undefined>) {
    const res = await fetch(buildUrl(baseUrl, path, params), {
        headers: apiKey ? { "X-API-Key": apiKey } : undefined,
    });
    if (!res.ok) {
        throw new Error(await parseErrorResponse(res));
    }
    return await res.json() as T;
}

async function apiGetBlob(baseUrl: string, apiKey: string, path: string) {
    const res = await fetch(buildUrl(baseUrl, path), {
        headers: apiKey ? { "X-API-Key": apiKey } : undefined,
    });
    if (!res.ok) {
        throw new Error(await parseErrorResponse(res));
    }
    return await res.blob();
}

const ICON_URL = new URL("./logo.ico", import.meta.url).toString();

const MyAnimeGifIcon: IconComponent = ({ height = 20, width = 20, className }) => {
    return (
        <img
            src={ICON_URL}
            width={width}
            height={height}
            className={className}
            aria-hidden="true"
            role="img"
            style={{ objectFit: "contain" }}
        />
    );
};

function MyAnimeGifModal({ rootProps, close }: { rootProps: ModalProps; close: () => void; }) {
    const { apiKey, baseUrl, useLocalDebug } = settings.use(["apiKey", "baseUrl", "useLocalDebug"]);
    const apiBaseUrl = useMemo(() => resolveBaseUrl(baseUrl, useLocalDebug), [baseUrl, useLocalDebug]);

    const [mode, setMode] = useState<"search" | "lists">("search");
    const [query, setQuery] = useState("");
    const [searchResults, setSearchResults] = useState<GifItem[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [searchPage, setSearchPage] = useState(1);
    const [searchHasMore, setSearchHasMore] = useState(false);

    const [lists, setLists] = useState<GifList[]>([]);
    const [listLoading, setListLoading] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const [selectedListId, setSelectedListId] = useState<number | null>(null);
    const [listItems, setListItems] = useState<GifItem[]>([]);
    const [listItemsLoading, setListItemsLoading] = useState(false);
    const [listItemsError, setListItemsError] = useState<string | null>(null);
    const [listPage, setListPage] = useState(1);
    const [listHasMore, setListHasMore] = useState(false);

    const [previewUrls, setPreviewUrls] = useState<Record<number, string>>({});
    const previewUrlsRef = useRef<Record<number, string>>({});

    useEffect(() => {
        previewUrlsRef.current = previewUrls;
    }, [previewUrls]);

    useEffect(() => {
        return () => {
            for (const url of Object.values(previewUrlsRef.current)) {
                URL.revokeObjectURL(url);
            }
        };
    }, []);

    useEffect(() => {
        setSearchResults([]);
        setLists([]);
        setListItems([]);
        setPreviewUrls({});
        setSearchError(null);
        setListError(null);
        setListItemsError(null);
    }, [apiBaseUrl, apiKey]);

    const runSearch = useCallback(async (searchQuery: string, page: number, replace: boolean) => {
        setSearchLoading(true);
        setSearchError(null);
        try {
            const data = await apiGet<GifSearchResponse>(apiBaseUrl, apiKey, "/gifs", {
                q: searchQuery,
                visibility: "published",
                sort_by: "created_at",
                order: "desc",
                page,
                limit: SEARCH_LIMIT,
            });
            setSearchResults(prev => replace ? data.items : [...prev, ...data.items]);
            setSearchPage(data.pagination.page);
            setSearchHasMore(Boolean(data.pagination.has_more));
        } catch (err) {
            setSearchError(err instanceof Error ? err.message : "Search failed");
        } finally {
            setSearchLoading(false);
        }
    }, [apiBaseUrl, apiKey]);

    const runFetchLists = useCallback(async () => {
        if (!apiKey) {
            setListError("API key required to load your GIF lists.");
            return;
        }
        setListLoading(true);
        setListError(null);
        try {
            const data = await apiGet<GifList[]>(apiBaseUrl, apiKey, "/gif-lists");
            setLists(data);
            if (data.length > 0 && selectedListId == null) {
                setSelectedListId(data[0].id);
            }
        } catch (err) {
            setListError(err instanceof Error ? err.message : "Failed to load lists");
        } finally {
            setListLoading(false);
        }
    }, [apiBaseUrl, apiKey, selectedListId]);

    const runFetchListItems = useCallback(async (listId: number, page: number, replace: boolean) => {
        if (!apiKey) {
            setListItemsError("API key required to load list items.");
            return;
        }
        setListItemsLoading(true);
        setListItemsError(null);
        try {
            const data = await apiGet<GifListResponse>(apiBaseUrl, apiKey, `/gif-lists/${listId}/items`, {
                page,
                limit: LIST_LIMIT,
            });
            setListItems(prev => replace ? data.items : [...prev, ...data.items]);
            setListPage(data.pagination.page);
            setListHasMore(Boolean(data.pagination.has_more));
        } catch (err) {
            setListItemsError(err instanceof Error ? err.message : "Failed to load list items");
        } finally {
            setListItemsLoading(false);
        }
    }, [apiBaseUrl, apiKey]);

    useEffect(() => {
        if (mode !== "search") return;
        const trimmed = query.trim();
        if (!trimmed) {
            setSearchResults([]);
            setSearchHasMore(false);
            setSearchError(null);
            return;
        }
        const handle = setTimeout(() => {
            runSearch(trimmed, 1, true);
        }, 350);
        return () => clearTimeout(handle);
    }, [query, mode, runSearch]);

    useEffect(() => {
        if (mode !== "lists") return;
        if (lists.length === 0 && !listLoading && !listError) {
            runFetchLists();
        }
    }, [mode, lists.length, listLoading, listError, runFetchLists]);

    useEffect(() => {
        if (mode !== "lists") return;
        if (selectedListId == null) return;
        runFetchListItems(selectedListId, 1, true);
    }, [mode, selectedListId, runFetchListItems]);

    useEffect(() => {
        const visibleItems = mode === "search" ? searchResults : listItems;
        let cancelled = false;

        const fetchPreviews = async () => {
            for (const gif of visibleItems) {
                if (previewUrlsRef.current[gif.id]) continue;
                try {
                    const blob = await apiGetBlob(apiBaseUrl, apiKey, `/media/gifs/${gif.id}/preview`);
                    if (cancelled) return;
                    const url = URL.createObjectURL(blob);
                    setPreviewUrls(prev => ({ ...prev, [gif.id]: url }));
                } catch { }
            }
        };

        fetchPreviews();
        return () => {
            cancelled = true;
        };
    }, [mode, searchResults, listItems, apiBaseUrl, apiKey]);

    const visibleItems = mode === "search" ? searchResults : listItems;
    const isLoading = mode === "search" ? searchLoading : listItemsLoading;
    const errorText = mode === "search" ? searchError : listItemsError;
    const hasMore = mode === "search" ? searchHasMore : listHasMore;

    const handleSend = (gif: GifItem) => {
        const channel = getCurrentChannel();
        if (!channel) return;
        sendMessage(channel.id, { content: gif.public_url });
        close();
    };

    return (
        <ModalRoot {...rootProps} size={ModalSize.LARGE} className="myanimegif-modal">
            <ModalHeader>
                <Forms.FormTitle tag="h2">MyAnimeGif</Forms.FormTitle>
                <ModalCloseButton onClick={close} />
            </ModalHeader>
            <ModalContent>
                {!apiKey && (
                    <Forms.FormText className="myanimegif-error">
                        Add your API key in the plugin settings to access private previews and lists.
                    </Forms.FormText>
                )}
                <div className="myanimegif-tabs">
                    <Button
                        size={Button.Sizes.SMALL}
                        color={mode === "search" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                        onClick={() => setMode("search")}
                    >
                        Search
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={mode === "lists" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                        onClick={() => setMode("lists")}
                    >
                        Lists
                    </Button>
                </div>

                {mode === "search" && (
                    <div className="myanimegif-search">
                        <TextInput
                            value={query}
                            onChange={setQuery}
                            placeholder="Search MyAnimeManager GIFs..."
                        />
                    </div>
                )}

                {mode === "lists" && (
                    <div className="myanimegif-list-row">
                        <div className="myanimegif-list-panel">
                            {listLoading && <Forms.FormText>Loading lists...</Forms.FormText>}
                            {listError && <Forms.FormText className="myanimegif-error">{listError}</Forms.FormText>}
                            {!listLoading && lists.length === 0 && !listError && (
                                <Forms.FormText className="myanimegif-empty">No lists found.</Forms.FormText>
                            )}
                            {lists.map(list => (
                                <Button
                                    key={list.id}
                                    size={Button.Sizes.SMALL}
                                    color={selectedListId === list.id ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                    className="myanimegif-list-button"
                                    onClick={() => setSelectedListId(list.id)}
                                >
                                    {list.name} ({list.gif_count})
                                </Button>
                            ))}
                        </div>
                    </div>
                )}

                {errorText && <Forms.FormText className="myanimegif-error">{errorText}</Forms.FormText>}
                {isLoading && <Forms.FormText>Loading...</Forms.FormText>}
                {!isLoading && visibleItems.length === 0 && !errorText && (
                    <Forms.FormText className="myanimegif-empty">
                        {mode === "search" ? "No results yet. Try a search." : "No GIFs in this list."}
                    </Forms.FormText>
                )}

                <div className="myanimegif-grid">
                    {visibleItems.map(gif => (
                        <button
                            key={gif.id}
                            className="myanimegif-card"
                            onClick={() => handleSend(gif)}
                            title="Send GIF"
                        >
                            <div className="myanimegif-thumb">
                                {previewUrls[gif.id] ? (
                                    <img src={previewUrls[gif.id]} alt={`GIF ${gif.id}`} />
                                ) : (
                                    <div className="myanimegif-thumb-placeholder">Preview...</div>
                                )}
                            </div>
                            <div className="myanimegif-meta">#{gif.id}</div>
                        </button>
                    ))}
                </div>

                {hasMore && !isLoading && (
                    <div className="myanimegif-load-more">
                        <Button
                            size={Button.Sizes.SMALL}
                            onClick={() => {
                                if (mode === "search") {
                                    runSearch(query.trim(), searchPage + 1, false);
                                } else if (selectedListId != null) {
                                    runFetchListItems(selectedListId, listPage + 1, false);
                                }
                            }}
                        >
                            Load more
                        </Button>
                    </div>
                )}
            </ModalContent>
        </ModalRoot>
    );
}

const MyAnimeGifButton: ChatBarButtonFactory = ({ isAnyChat }) => {
    if (!isAnyChat) return null;
    return (
        <ChatBarButton
            tooltip="Search MyAnimeManager GIFs"
            onClick={() => {
                const key = openModal(props => (
                    <MyAnimeGifModal
                        rootProps={props}
                        close={() => closeModal(key)}
                    />
                ));
            }}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <MyAnimeGifIcon />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "MyAnimeGif",
    description: "Search and share MyAnimeManager GIFs from the chat bar.",
    authors: [{ name: "MiDevelopment" }],
    startAt: StartAt.Init,
    settings,
    chatBarButton: {
        icon: MyAnimeGifIcon,
        render: MyAnimeGifButton,
    },
});
