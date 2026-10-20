/* WebMCP tools for the Quorly editor (W3C Web Machine Learning CG draft, checked 2026-10-19).
 *
 * WebMCP lets an in-browser agent call named tools instead of driving the UI. Support today:
 * Chrome/Edge behind the origin trial or chrome://flags/#enable-webmcp-testing, and ChatGPT
 * desktop's built-in browser (imperative tools only, top-level document only). Every other
 * browser simply ignores this file, so it is a progressive enhancement, not a dependency.
 *
 * Rules this file follows (see the WebMCP safety notes):
 *   - Every tool calls the same function the UI calls. No privileged back door.
 *   - Destructive tools are marked `consequentialHint` AND still ask the person in-page.
 *   - Tools that return user-written text are marked `untrustedContentHint`.
 *   - Nothing here is registered cross-origin; `exposedTo` is left at its default.
 *   - Registration is torn down with an AbortController (the draft has no unregisterTool).
 *
 * The API is detected on `document.modelContext` first and the legacy `navigator.modelContext`
 * second. If neither registers tools, the file exits without side effects.
 */
(function () {
  'use strict';

  const mc = (typeof document !== 'undefined' && document.modelContext) ||
             (typeof navigator !== 'undefined' && navigator.modelContext);

  if (!mc || typeof mc.registerTool !== 'function') return;

  const controller = new AbortController();

  // MCP content convention: tools answer with a content array. Human-readable JSON keeps the
  // result useful to models that cannot parse structured tool output yet.
  function ok(payload) {
    return {
      content: [{
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
      }]
    };
  }

  function err(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  // Same anonymous counter the rest of the app uses. Tool names are not document content.
  function logTool(name) {
    try {
      if (typeof track === 'function') track('webmcp_tool', { tool: name });
    } catch (_) {
      // Analytics must never break a tool call.
    }
  }

  function documentState() {
    return {
      id: (typeof currentId !== 'undefined' && currentId) || null,
      title: (editTitle.textContent || '').trim() || 'Untitled',
      wordCount: countWords()
    };
  }

  function placeCaretAtEnd() {
    preserveScroll(function () {
      editBody.focus();
      const range = document.createRange();
      range.selectNodeContents(editBody);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
  }

  function hasContent() {
    return (editBody.textContent || '').trim().length > 0;
  }

  const tools = [
    {
      name: 'get_document',
      title: 'Read the open Quorly document',
      description:
        'Return the title, Markdown source and word count of the document currently open in the ' +
        'Quorly editor. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute() {
        logTool('get_document');
        return ok(Object.assign(documentState(), { markdown: convertToMarkdown() }));
      }
    },

    {
      name: 'list_documents',
      title: 'List saved Quorly documents',
      description:
        'List the documents saved in this browser (most recent first), with their ids, titles, ' +
        'word counts and last-edited times. Optionally filter by a title substring. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional case-insensitive title filter.' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input) {
        logTool('list_documents');
        const query = input && typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
        const documents = readIndex()
          .filter(function (entry) {
            return !query || (entry.title || '').toLowerCase().indexOf(query) !== -1;
          })
          .map(function (entry) {
            return {
              id: entry.id,
              title: entry.title || 'Untitled',
              wordCount: entry.wordCount || 0,
              updatedAt: entry.updatedAt || null,
              updatedAtISO: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null,
              isOpen: entry.id === currentId
            };
          });
        return ok({ documents: documents });
      }
    },

    {
      name: 'open_document',
      title: 'Open a saved document',
      description:
        'Open one of the documents listed by list_documents in the editor, replacing what is ' +
        'currently on screen. The previously open document is kept in the library.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Document id from list_documents.' }
        },
        required: ['id'],
        additionalProperties: false
      },
      async execute(input) {
        logTool('open_document');
        const id = input && typeof input.id === 'string' ? input.id.trim() : '';
        if (!id) return err('An id from list_documents is required.');
        if (!readIndex().some(function (entry) { return entry.id === id; })) {
          return err('No saved document has that id.');
        }
        await openRecent(id);
        if (currentId !== id) return err('The document could not be opened.');
        return ok(Object.assign(documentState(), { opened: true }));
      }
    },

    {
      name: 'create_document',
      title: 'Create a new document',
      description:
        'Start a new, empty document. The current document is saved to the library first, so ' +
        'nothing is lost.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        logTool('create_document');
        await newFile();
        return ok(Object.assign(documentState(), { created: true }));
      }
    },

    {
      name: 'set_document_title',
      title: 'Set the document title',
      description: 'Change the title of the open document. The body is untouched.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'New title, up to 300 characters.' }
        },
        required: ['title'],
        additionalProperties: false
      },
      async execute(input) {
        logTool('set_document_title');
        const title = input && typeof input.title === 'string' ? input.title.trim() : '';
        if (!title) return err('A non-empty title is required.');
        editTitle.textContent = title.slice(0, 300);
        saveToLocalStorage();
        updateStats();
        return ok(documentState());
      }
    },

    {
      name: 'append_content',
      title: 'Append content to the document',
      description:
        'Append Markdown to the end of the open document. Existing content is not modified. ' +
        'Supports the Markdown the editor imports: headings, lists, quotes, code, tables and ' +
        'images by URL.',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Markdown to append.' }
        },
        required: ['markdown'],
        additionalProperties: false
      },
      async execute(input) {
        logTool('append_content');
        const markdown = input && typeof input.markdown === 'string' ? input.markdown : '';
        if (!markdown.trim()) return err('Markdown content is required.');
        const parsed = markdownToClean(markdown);
        if (!parsed) return err('The Markdown renderer is unavailable.');
        placeCaretAtEnd();
        while (parsed.firstChild) editBody.appendChild(parsed.firstChild);
        applyTableWidths();
        attachBodyImageDeleteButtons();
        applyCodeHighlighting();
        saveToLocalStorage();
        updateStats();
        return ok(Object.assign(documentState(), { appended: true }));
      }
    },

    {
      name: 'replace_document_content',
      title: 'Replace the document content',
      description:
        'Replace the body of the open document with Markdown, optionally setting a new title. ' +
        'This discards the current body, so the editor asks the person to confirm first.',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'New body, as Markdown.' },
          title: { type: 'string', description: 'Optional new title.' }
        },
        required: ['markdown'],
        additionalProperties: false
      },
      annotations: { consequentialHint: true },
      async execute(input) {
        logTool('replace_document_content');
        const markdown = input && typeof input.markdown === 'string' ? input.markdown : '';
        if (!markdown.trim()) return err('Markdown content is required.');
        const parsed = markdownToClean(markdown);
        if (!parsed) return err('The Markdown renderer is unavailable.');
        if (hasContent() && typeof window.confirm === 'function') {
          const title = (editTitle.textContent || '').trim() || 'this untitled document';
          if (!window.confirm('Replace the whole body of "' + title + '"? This cannot be undone.')) {
            return err('The person declined the replacement.');
          }
        }
        isLoading = true;
        editBody.textContent = '';
        while (parsed.firstChild) editBody.appendChild(parsed.firstChild);
        if (input && typeof input.title === 'string' && input.title.trim()) {
          editTitle.textContent = input.title.trim().slice(0, 300);
        }
        isLoading = false;
        applyTableWidths();
        attachBodyImageDeleteButtons();
        applyCodeHighlighting();
        saveToLocalStorage();
        updateStats();
        return ok(Object.assign(documentState(), { replaced: true }));
      }
    },

    {
      name: 'insert_table',
      title: 'Insert a table',
      description:
        'Insert an editable table at the end of the open document. The first row is the header.',
      inputSchema: {
        type: 'object',
        properties: {
          rows: { type: 'integer', minimum: 1, maximum: 20, description: 'Total rows including the header (default 3).' },
          columns: { type: 'integer', minimum: 1, maximum: 20, description: 'Number of columns (default 3).' }
        },
        additionalProperties: false
      },
      async execute(input) {
        logTool('insert_table');
        const rows = input && Number.isInteger(input.rows) ? input.rows : 3;
        const columns = input && Number.isInteger(input.columns) ? input.columns : 3;
        placeCaretAtEnd();
        insertTable(rows, columns);
        saveToLocalStorage();
        updateStats();
        return ok({ rows: Math.max(1, Math.min(20, rows)), columns: Math.max(1, Math.min(20, columns)) });
      }
    },

    {
      name: 'set_reading_preferences',
      title: 'Set reading preferences',
      description:
        'Adjust how the editor looks: colour theme, reading font, body text size and column ' +
        'width. Any field may be omitted; only the supplied fields change.',
      inputSchema: {
        type: 'object',
        properties: {
          theme: { type: 'string', enum: ['dark', 'light'], description: 'Colour theme.' },
          font: { type: 'string', enum: ['Default', 'Lora', 'Roboto', 'Inter'], description: 'Reading font.' },
          fontSize: { type: 'integer', minimum: 12, maximum: 28, description: 'Body text size in pixels.' },
          width: { type: 'integer', minimum: 720, maximum: 1320, description: 'Reading column width in pixels.' }
        },
        additionalProperties: false
      },
      async execute(input) {
        logTool('set_reading_preferences');
        input = input || {};
        const applied = {};

        if (input.theme === 'dark' || input.theme === 'light') {
          const isLight = document.body.classList.contains('light-mode');
          if ((input.theme === 'light') !== isLight) toggleMode();
          applied.theme = input.theme;
        }

        if (typeof input.font === 'string') {
          const fonts = ['Default', 'Lora', 'Roboto', 'Inter'];
          if (fonts.indexOf(input.font) === -1) return err('Unknown font.');
          changeTypography(input.font);
          const dropdown = document.getElementById('typographyDropdown');
          const value = dropdown && dropdown.querySelector('.dropdown-value');
          if (value) value.textContent = input.font;
          if (dropdown) {
            dropdown.querySelectorAll('[role="option"]').forEach(function (option) {
              option.setAttribute('aria-selected', String(option.getAttribute('data-value') === input.font));
            });
          }
          applied.font = input.font;
        }

        if (Number.isInteger(input.fontSize)) {
          const size = Math.max(12, Math.min(28, input.fontSize));
          setFontSize(size);
          applied.fontSize = size;
        }

        if (Number.isInteger(input.width)) {
          const width = Math.max(720, Math.min(1320, input.width));
          setWidth(width);
          const dropdown = document.getElementById('docWidthDropdown');
          if (dropdown) {
            dropdown.querySelectorAll('[role="option"]').forEach(function (option) {
              option.setAttribute('aria-selected', String(Number(option.getAttribute('data-value')) === width));
            });
          }
          applied.width = width;
        }

        if (!Object.keys(applied).length) return err('Supply at least one preference to change.');
        return ok(applied);
      }
    },

    {
      name: 'delete_document',
      title: 'Delete a saved document',
      description:
        'Delete a document from this browser permanently. The editor asks the person to confirm ' +
        'before anything is removed.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Document id from list_documents.' }
        },
        required: ['id'],
        additionalProperties: false
      },
      annotations: { consequentialHint: true },
      async execute(input) {
        logTool('delete_document');
        const id = input && typeof input.id === 'string' ? input.id.trim() : '';
        if (!id) return err('An id from list_documents is required.');
        if (!readIndex().some(function (entry) { return entry.id === id; })) {
          return err('No saved document has that id.');
        }
        await deleteRecent(id);
        const stillThere = readIndex().some(function (entry) { return entry.id === id; });
        if (stillThere) return err('The person declined the deletion.');
        return ok({ deleted: true, id: id });
      }
    }
  ];

  // Register sequentially so a failure in one tool never hides the rest.
  (async function registerAll() {
    for (const tool of tools) {
      try {
        await mc.registerTool(tool, { signal: controller.signal });
      } catch (error) {
        console.warn('WebMCP: could not register "' + tool.name + '"', error);
      }
    }
  })();

  // The draft has no unregisterTool: aborting removes every tool registered with this signal.
  window.addEventListener('pagehide', function () {
    try { controller.abort(); } catch (_) { /* nothing to clean up */ }
  }, { once: true });
})();
