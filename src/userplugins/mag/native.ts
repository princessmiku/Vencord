/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

export async function fetchMagApi(
    _: IpcMainInvokeEvent,
    url: string,
    options?: RequestInit
) {
    try {
        const res = await fetch(url, options);
        const data = await res.json();

        return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            data: data
        };
    } catch (error) {
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
