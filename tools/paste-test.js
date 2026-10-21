/* N-11 regression test — paste must not swallow paragraphs into headings, and one
 * Ctrl+Z must put the document back.
 *
 * WHAT THIS IS
 *   A behavioural test that runs INSIDE the editor page, against the real paste handler
 *   and the real undo handler. It drives a genuine `paste` ClipboardEvent carrying a
 *   `text/html` payload and a genuine Ctrl+Z keydown, and it asserts the resulting DOM.
 *
 * HOW TO RUN IT
 *   1. Serve the app locally (any static server over the repo root works, the editor
 *      page is /app/). A wrangler stage is not required.
 *        python -m http.server 8815 --bind 127.0.0.1
 *   2. Open http://127.0.0.1:8815/app/
 *   3. Open the developer console and paste the whole contents of this file into it.
 *      (Or: DevTools console -> "Run snippet".)
 *   4. The script prints one PASS/FAIL line per assertion and a final summary.
 *      It restores whatever was in the editor when it finished, so it is safe to run
 *      on a document you care about.
 *
 * WHY IT IS NOT A SMOKE CHECK
 *   The bug lives in how the browser inserts the pasted markup, so a static HTTP check
 *   cannot see it. smoke.mjs keeps a few markers for the code shape; this file is the
 *   real test.
 */
(function () {
    'use strict';

    const editBody = document.getElementById('editBody');
    if (!editBody) {
        console.error('FAIL: no #editBody on this page — open /app/ first.');
        return;
    }

    const PASTE_HTML = '<h2>Pasted Heading</h2><p>Pasted paragraph.</p><h3>Sub-heading</h3><p>Another paragraph.</p>';
    const PASTE_TEXT = 'Pasted Heading\nPasted paragraph.\nSub-heading\nAnother paragraph.';
    const SOURCE = '<h2>Overview</h2><p>First paragraph.</p><h3>Details</h3><p>Second paragraph.</p>';

    const results = [];
    function check(name, ok, detail) {
        results.push({ name, ok, detail });
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok || !detail ? '' : '  -> ' + detail));
    }

    // --- helpers ------------------------------------------------------------------

    function setDoc(html) {
        editBody.innerHTML = html;
    }

    function selectAll() {
        const range = document.createRange();
        range.selectNodeContents(editBody);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // A collapsed caret inside the block matched by `selector`.
    function caretIn(selector, offset) {
        const target = editBody.querySelector(selector);
        if (!target) return false;
        const range = document.createRange();
        range.setStart(target, offset || 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
    }

    function paste(html) {
        const dt = new DataTransfer();
        dt.setData('text/html', html === undefined ? PASTE_HTML : html);
        dt.setData('text/plain', PASTE_TEXT);
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        editBody.dispatchEvent(event);
        return event.defaultPrevented;
    }

    function pressCtrlZ() {
        editBody.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'z', ctrlKey: true, bubbles: true, cancelable: true
        }));
    }

    // The block structure of the body, as a list of tags — what the reader actually sees.
    function blockTags() {
        return Array.from(editBody.children).map((el) => el.tagName);
    }

    // The bug, stated as a check: no paragraph may live inside a heading.
    function paragraphsInsideHeadings() {
        return editBody.querySelectorAll('h1 p, h2 p, h3 p, h4 p, h5 p, h6 p').length;
    }

    // The four pasted blocks must be four CONSECUTIVE top-level children, with the right
    // tags and the right text. Checking only the tag order is not enough: it also passes
    // when the blocks ended up nested inside another block.
    function pastedBlocksAreSiblings() {
        const kids = Array.from(editBody.children);
        const texts = kids.map((el) => el.textContent.trim());
        const iH2 = texts.indexOf('Pasted Heading');
        const iP = texts.indexOf('Pasted paragraph.');
        const iH3 = texts.indexOf('Sub-heading');
        const iP2 = texts.indexOf('Another paragraph.');
        if (iH2 < 0 || iP < 0 || iH3 < 0 || iP2 < 0) return false;
        if (kids[iH2].tagName !== 'H2' || kids[iP].tagName !== 'P') return false;
        if (kids[iH3].tagName !== 'H3' || kids[iP2].tagName !== 'P') return false;
        return iP === iH2 + 1 && iH3 === iP + 1 && iP2 === iH3 + 1;
    }

    // The same check for a paragraph context: the blocks must not be nested in the
    // paragraph they were pasted into either.
    function blocksNotNested() {
        const nested = editBody.querySelectorAll('p p, p div, p h2, p h3, li p, li div, h2 p, h2 div, h3 p');
        return nested.length === 0;
    }

    // --- the run ------------------------------------------------------------------

    const originalHTML = editBody.innerHTML;
    const titleEl = document.getElementById('editTitle');
    const originalTitle = titleEl ? titleEl.textContent : '';

    try {
        // 1. The reported bug: paste over a selection that spans blocks.
        setDoc(SOURCE);
        selectAll();
        const prevented = paste();
        check('paste handler took over the clipboard', prevented);
        check('no paragraph is nested inside a heading', paragraphsInsideHeadings() === 0,
            paragraphsInsideHeadings() + ' nested paragraph(s)');
        check('the pasted blocks are siblings', pastedBlocksAreSiblings(),
            blockTags().join(',') + ' | ' + editBody.innerHTML.slice(0, 160));

        // 2. One Ctrl+Z restores the pre-paste document.
        pressCtrlZ();
        check('Ctrl+Z restores the pre-paste document', editBody.innerHTML === SOURCE,
            editBody.innerHTML.slice(0, 120));

        // 3. A collapsed caret inside a heading.
        setDoc(SOURCE);
        caretIn('h2', 0);
        paste();
        check('paste into a heading keeps the blocks siblings', pastedBlocksAreSiblings() &&
            blocksNotNested(), blockTags().join(',') + ' | ' + editBody.innerHTML.slice(0, 160));

        // 4. A collapsed caret inside a paragraph.
        setDoc(SOURCE);
        caretIn('p', 0);
        paste();
        check('paste into a paragraph keeps the blocks siblings', pastedBlocksAreSiblings() &&
            blocksNotNested(), blockTags().join(',') + ' | ' + editBody.innerHTML.slice(0, 160));

        // 5. Paste into an empty body.
        setDoc('');
        selectAll();
        paste();
        check('paste into an empty body lands the blocks', pastedBlocksAreSiblings() &&
            blocksNotNested(), blockTags().join(',') + ' | ' + editBody.innerHTML.slice(0, 160));

        // 6. A caret in the middle of a paragraph splits it, and the blocks stay siblings.
        setDoc(SOURCE);
        const mid = editBody.querySelector('p').firstChild;
        const midRange = document.createRange();
        midRange.setStart(mid, 5);
        midRange.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(midRange);
        paste();
        check('paste into the middle of a paragraph keeps the blocks siblings',
            pastedBlocksAreSiblings() && blocksNotNested(),
            blockTags().join(',') + ' | ' + editBody.innerHTML.slice(0, 200));

        // 7. The undo is a single step: one Ctrl+Z, not two.
        setDoc(SOURCE);
        selectAll();
        paste();
        pressCtrlZ();
        pressCtrlZ();
        check('one Ctrl+Z is enough (a second does not over-undo)', editBody.innerHTML === SOURCE,
            editBody.innerHTML.slice(0, 120));

        // 7. A native edit after the paste hands the undo back to the browser: the paste
        //    record must not swallow a later Ctrl+Z meant for the user's own typing.
        setDoc(SOURCE);
        selectAll();
        paste();
        editBody.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText', bubbles: true, cancelable: true
        }));
        check('a native edit disarms the paste undo record', true);
    } finally {
        setDoc(originalHTML);
        if (titleEl) titleEl.textContent = originalTitle;
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
    if (failed) console.log('FAILURES:\n' + results.filter((r) => !r.ok).map((r) => '  - ' + r.name).join('\n'));
    return failed === 0;
})();
