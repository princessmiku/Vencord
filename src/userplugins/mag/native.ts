/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

export async function fetchMagApi(
    _: IpcMainInvokeEvent,
    url: string,
    options?: RequestInit & { headers?: Record<string, string> }
) {
    try {
        const target = new URL(url);
        if (target.origin !== "https://api.midevelopment.de" || !target.pathname.startsWith("/api/")) {
            throw new Error("Unsupported MAM API URL.");
        }
        const res = await fetch(target, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
        const text = await res.text();

        let data: unknown = null;

        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = {
                    error: "Response was not valid JSON.",
                    body: text.slice(0, 500)
                };
            }
        }

        return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            data
        };
    } catch (error) {
        console.error("[MAM] Native request failed:", error);

        return {
            ok: false,
            status: -1,
            statusText: "Network Error",
            data: {
                error: error instanceof Error ? error.message : String(error)
            }
        };
    }
}
