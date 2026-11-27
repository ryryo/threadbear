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

## Picker repair and acceptance

The first implementation used a screenshot for selection and queried the live DOM after the click. Its fixed-coordinate tests showed that a picture could be added, but did not compare the selected pixels or enter a comment. Treat the picker acceptance checks above as open.

1. Run the live DOM parts of T3 Code's fixed revision `c2fcbd79523e` in a CEF isolated world. Port `PickTarget.ts` and the selection, focus, pointer interception and teardown from `PickPreload.ts`. Keep the existing crop geometry. Replace Electron's transport with a session tied to the originating CEF page and document. The page cannot nominate the thread or an attachment path. Keep typing in the GPUI input so that page JavaScript cannot observe the comment's keystrokes through DOM events. Move focus there after the picker reports a selection.
2. Verify that the element never activates, a different element can be picked without losing the comment, and the native page stays in view while choosing. Support viewport rectangle selection including canvas or inaccessible frames. Capture the image only after the selection is ready for review. Compare the viewport and target around capture; if they change or the image fails, keep the comment and target.
3. Show the actual crop and let the user omit the image, go back to selection or cancel. Only the final Add to draft action commits. Cancel pending work on navigation, dismissal and thread change. Continue a confirmed save to the original thread.
4. Verify the result in the real CEF fixture. Use a known colored target to check the selected pixels and enter a non-ASCII comment. Check viewport changes, cancellation, text without an image and draft restart. Verify real macOS focus and IME separately from automation using inserted text. Public distribution still requires separate renderer-sandbox verification.

## Implementation and verification

- The Browser view uses the existing native panel pool, runtime setup, dock and BrowserBear list. Its original Highlights page preview route was removed when the link actions moved to Browser.
- The T3 Code geometry port lives in `desktop/gpui/src/browser_notes/geometry.rs`. The new GPUI selection code uses the existing CEF DevTools bridge for the image and element bounds. The draft code uses the existing private image staging, `media.import`, draft file, and message image format. The capture and the comment stay in one draft record.
- Verified on macOS with Chromium: ten scripted scenarios passed, covering the globe, reply and pin opening, the external default, element and region capture, restart and thread isolation, BrowserBear handoff and an existing patch panel. The separate Google smoke test verified a live Browser panel and a direct external open from Command-click. The bundled Chromium renderer sandbox remains a separate packaging check for broader distribution.

### Live picker repair

- The CEF picker adapts T3 Code's hit testing, clipped outline and pointer handling in `desktop/gpui/src/browser_notes/picker.js`. The isolated world exchanges only the selection and viewport with the app. The app owns the comment, image review and draft.
- In the macOS CEF test build, all four picker scenarios passed. They included Japanese text directed to the focused input, a scrolled and resized page whose cropped pixel and dimensions matched an independent Chromium screenshot, image exclusion, cancellation on thread change, and restoration of the saved image after restart. Six browser routing, BrowserBear and patch panel regression scenarios also passed. The screenshot profile is preserved by the crop. The automated text test does not exercise a real IME conversion.
- Distribution verification of the renderer sandbox remains open. These scenarios used an existing locally installed runtime in an isolated fixture, not a packaged sandboxed renderer.
