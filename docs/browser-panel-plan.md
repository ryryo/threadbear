# Browser panel and page comments

## First release

- Always show Browser (the globe), including without BrowserBear. Open a URL entered there or an explicit Open in Panel in the selected thread's browser. Highlights keeps the pin list. Ordinary URL clicks and requests to show a URL pin follow the user's link default. The explicit external action and Command-click open the external browser directly.
- Keep the BrowserBear tab list and its existing sign-in handoff available from Browser. Keep the native browser page and the agent's actual browser tab distinct. Identify a live page by its tab and document, never by URL alone.
- Let the user click a single page element or drag a rectangle. Show the selection, allow a comment, and let the user review or discard the crop. Add the URL, page title, target, comment and optional image as a single item in the originating thread's draft. The user sends the message. If the crop fails, retain the written comment and target.
- Cancel an unconfirmed selection on navigation, reload, dismissal or thread change. A confirmed capture can only affect its originating draft. Persist confirmed comments alongside existing draft attachments. Do not collect form values, cookies or raw HTML.
- Verify the packaged Chromium renderer sandbox before expanding ordinary public browsing beyond the existing link preview. Maintain separate rules and browser contexts for public browsing and trusted patch or Convex content.

## References and later work

[T3 Code's browser](https://github.com/pingdotgg/t3code/blob/c2fcbd79523e0731a6d0ed354c3ec1e36713bb88/docs/user/browser.md) supplies the element and region interaction. [Its session-split report](https://github.com/pingdotgg/t3code/issues/16901) is a regression case for future shared sessions. The [old Swift link policy](https://github.com/mikecann/threadbear/blob/c13cbe63d364d61dd17e99a644923ed5a2853f5d/app/Sources/Threadbear/PaneModel.swift#L149-L236) supplies the default and explicit open actions.

[Wayne's external tab picker](https://github.com/mikecann/threadbear/issues/113), [external window placement](https://github.com/mikecann/threadbear/issues/115), and [the old Swift live mirror](https://github.com/mikecann/threadbear/blob/d090ca29996cb7a18a6a275e43f3c699c9913860/app/Sources/Threadbear/Views/AgentBrowserPanel.swift#L574) inform future work on shared agent tabs. Shared input needs exclusive control, cancellation of queued input on handoff, and matching displayed and controlled tab identities across reconnects.

## Acceptance checks

1. With BrowserBear unavailable, open Google from the globe and through Open in Panel. Use back, forward and reload. Confirm Chrome opens directly through its explicit menu or Command-click and the default governs ordinary links and shown URL pins.
2. On a local fixture, pick a button without activating it, and pick a rectangle on a canvas. Add a comment to each. Compare the cropped pixels against the selected bounds at Retina scale and after resizing. Check failed captures leave comments and that adding never sends.
3. Switch threads, reload and navigate during a capture. Verify no result appears in the wrong draft. Restart the app with a saved annotation and verify the draft and image restore.
4. Confirm BrowserBear can still open its original sign-in tab and the existing trusted patch and Convex panels retain their restrictions.

## Reuse before adding code

- Keep the existing GPUI BrowserBear window, stills, discovery and handoff. Use Swift's `PaneModel.openLink`, `openTranscriptWebLink`, `PanelRequestModel.showPinned` and `TextKit` as the routing contract. Reuse GPUI's existing link menu, dock, native CEF view pool, runtime and composer attachment storage.
- Port the [T3 Code capture geometry and validation](https://github.com/pingdotgg/t3code/blob/c2fcbd79523e0731a6d0ed354c3ec1e36713bb88/apps/desktop/src/preview/Manager.ts#L261-L334) and [picker's structured submission and cancellation](https://github.com/pingdotgg/t3code/blob/c2fcbd79523e0731a6d0ed354c3ec1e36713bb88/apps/desktop/src/preview/PickPreload.ts#L1758-L1849). Keep its separate text/image outcomes. Never substitute a full-page image for a failed crop. Replace Electron IPC and `capturePage` with the existing CEF DevTools bridge and GPUI input, and omit raw HTML and form values.
- For the external picker, reuse [Wayne's capture and thread association](https://github.com/waynesutton/threadbear/commit/56070153d98c9003b6b427bdbbadf170b0cbc9f6) and [page picker](https://github.com/waynesutton/browserbear/commit/0123116122174acff6cd720b91f680ec27d0809d) where the external-tab feature is used. Do not put BrowserBear-specific service startup in the embedded picker. Preserve MIT notices with sourced code.

The port of T3 Code's crop geometry is covered by the [T3 Code MIT notice](third-party/t3-code-MIT.txt).
