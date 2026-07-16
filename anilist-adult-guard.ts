/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// =============================================================================
// AniList Adult Content Guard
// =============================================================================
//
// WHAT THIS DOES
// ---------------
// Stops Seanime from ever sending an episode-progress update to AniList for
// any anime flagged "isAdult" - no progress number, no status change
// (Watching/Completed/Repeating), nothing. Since AniList itself is what
// generates "watched episode X of Y" activity posts whenever a list entry's
// progress changes, blocking the update at the source means the update -
// and the activity post - never happens. Non-adult anime are completely
// unaffected and continue to sync exactly as before.
//
// WHY THIS HOOK
// -------------
// Seanime has three separate playback pipelines that can push progress to
// AniList: local files / torrent / debrid streams (internal/library/
// playbackmanager), the built-in online-streaming player used for
// AniZone/KickAssAnime-style extensions (internal/directstream, VideoCore),
// and a manual "Sync Progress" action. None of those packages expose a hook
// of their own - directstream in particular has no hook calls at all.
//
// But all three funnel into the exact same place before anything reaches
// the network: internal/platforms/anilist_platform's UpdateEntryProgress,
// which always calls TriggerUpdateEntryProgressHooks(). That helper fires
// $app.onPreUpdateEntryProgress BEFORE calling AniList, and if the handler
// calls preventDefault(), the update function is never invoked and the
// call to AniList is skipped entirely (confirmed straight from Seanime's
// source, not just the docs). That makes it the one choke point that
// covers every playback path with a single hook - so that's what this
// plugin uses, instead of trying to catch each pipeline separately or
// toggle the global "Automatically Update Progress" setting (which,
// as of this build, directstream's online-streaming path ignores anyway).
//
// SCOPE
// -----
// Only $anilist.updateEntryProgress-style calls are affected (progress
// number + the status changes bundled into it, e.g. auto-marking
// "Completed"). Manual edits to score/notes/custom lists via
// $anilist.updateEntry are untouched, so you can still rate or list an
// adult title on AniList - it just won't broadcast episode-by-episode
// watch activity. This only covers anime; manga chapter progress uses a
// separate code path and isn't affected.
//
// The hook runs in its own isolated runtime (separate from $ui.register),
// so it can't share plain variables with the tray UI below - that's why
// the two halves talk to each other through $store/$storage instead.
// =============================================================================

const STORAGE_ENABLED_KEY = "anilist-adult-guard:enabled"
const STORAGE_HISTORY_KEY = "anilist-adult-guard:history"
const STORE_EVENT_KEY = "anilist-adult-guard:event"
const MAX_HISTORY = 25

function init() {

    // -------------------------------------------------------------------
    // Hook runtime - fires right before Seanime would push progress to
    // AniList. This is the part that actually does the blocking.
    // -------------------------------------------------------------------
    $app.onPreUpdateEntryProgress((e) => {
        let enabled = true
        try {
            const stored = $storage.get<boolean>(STORAGE_ENABLED_KEY)
            if (stored === false) {
                enabled = false
            }
        } catch (err) {
            // Couldn't read the toggle - default to protecting the user's data.
            enabled = true
        }

        let blocked = false
        let reason = "allowed"
        let title: string | undefined = undefined

        if (enabled && typeof e.mediaId === "number") {
            try {
                const anime = $anilist.getAnime(e.mediaId)
                title = anime && anime.title ? anime.title.userPreferred : undefined

                if (anime && anime.isAdult === true) {
                    e.preventDefault()
                    blocked = true
                    reason = "adult"
                }
            } catch (err) {
                // Couldn't verify the content rating. Fail closed: skip this
                // one sync rather than risk letting an adult title slip
                // through because of a lookup hiccup. Worst case, a normal
                // title's progress is a manual "Sync Progress" click away.
                e.preventDefault()
                blocked = true
                reason = "lookup-failed"
            }
        }

        // Hand off a small event to the UI runtime for the tray log/badge.
        // This is best-effort - if it fails, the blocking above already
        // happened and is not affected.
        try {
            $store.set(STORE_EVENT_KEY, {
                mediaId: e.mediaId,
                title: title,
                progress: e.progress,
                blocked: blocked,
                reason: reason,
                at: Date.now(),
            })
        } catch (err) {
            // Non-critical, ignore.
        }

        e.next()
    })

    // -------------------------------------------------------------------
    // UI runtime - tray icon with an on/off switch and a short activity
    // log, purely for visibility. The guard above works even if this
    // whole block fails to load.
    // -------------------------------------------------------------------
    $ui.register((ctx) => {
        const enabled = ctx.state(true)
        const history = ctx.state<any[]>([])

        function loadPersistedState() {
            try {
                const storedEnabled = $storage.get<boolean>(STORAGE_ENABLED_KEY)
                enabled.set(storedEnabled !== false)
            } catch (err) {
                enabled.set(true)
            }
            try {
                const storedHistory = $storage.get<any[]>(STORAGE_HISTORY_KEY)
                history.set(storedHistory && storedHistory.length ? storedHistory : [])
            } catch (err) {
                history.set([])
            }
        }
        loadPersistedState()

        const tray = ctx.newTray({
            iconUrl: "https://anilist.co/img/icons/android-chrome-512x512.png",
            withContent: true,
            width: "360px",
        })

        function refreshBadge(items: any[]) {
            const blockedForAdultCount = items.filter((h) => h.blocked && h.reason === "adult").length
            tray.updateBadge({
                number: enabled.get() ? blockedForAdultCount : 0,
                intent: "warning",
            })
        }

        // Whenever the hook records an event, log it and refresh the tray.
        $store.watch<any>(STORE_EVENT_KEY, (event) => {
            if (!event) return

            const next = [event].concat(history.get()).slice(0, MAX_HISTORY)
            history.set(next)

            try {
                $storage.set(STORAGE_HISTORY_KEY, next)
            } catch (err) {
                // Non-critical, ignore.
            }

            refreshBadge(next)
        })

        ctx.registerEventHandler("anilist-adult-guard-toggle", (event: any) => {
            const next = typeof event === "boolean" ? event : !enabled.get()
            enabled.set(next)
            try {
                $storage.set(STORAGE_ENABLED_KEY, next)
            } catch (err) {
                ctx.toast.error("Could not save the setting, it may reset on restart.")
            }
            ctx.toast.info(next ? "Adult content will no longer sync to AniList" : "Guard disabled - adult titles will sync normally")
            refreshBadge(history.get())
        })

        ctx.registerEventHandler("anilist-adult-guard-clear-log", () => {
            history.set([])
            try {
                $storage.set(STORAGE_HISTORY_KEY, [])
            } catch (err) {
                // Non-critical, ignore.
            }
            tray.updateBadge({ number: 0 })
        })

        tray.render(() => {
            const items = history.get()
            const isEnabled = enabled.get()
            const blockedForAdultCount = items.filter((h) => h.blocked && h.reason === "adult").length

            const rows = [
                tray.text("AniList Adult Content Guard", { style: { fontWeight: "600", fontSize: "14px" } }),
                tray.switch({
                    label: "Block adult content from AniList",
                    value: isEnabled,
                    onChange: "anilist-adult-guard-toggle",
                }),
                tray.text(
                    isEnabled
                        ? `On - ${blockedForAdultCount} adult progress update${blockedForAdultCount === 1 ? "" : "s"} kept off AniList so far`
                        : "Off - adult titles will sync to AniList like anything else"
                ),
            ]

            if (items.length > 0) {
                rows.push(tray.text("Recent activity", { style: { fontWeight: "600", marginTop: "8px" } }))

                const logRows = items.slice(0, 10).map((h) => {
                    const label = h.title || ("Media #" + h.mediaId)
                    const statusText = h.blocked
                        ? (h.reason === "adult" ? "Blocked (adult)" : "Blocked (couldn't verify)")
                        : "Synced normally"
                    return tray.text(`${statusText} - ${label}`, { style: { fontSize: "12px" } })
                })

                rows.push(tray.stack(logRows, { gap: 2 }))
                rows.push(tray.button("Clear log", { onClick: "anilist-adult-guard-clear-log", size: "xs" }))
            }

            return tray.stack(rows, { gap: 8 })
        })
    })
}
