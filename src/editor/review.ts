import { spawn, spawnSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, renameSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import type { FeedbackComment, FeedbackResult } from '../types.js';

export interface ReviewOptions {
  /** Where the answers JSON is written (live autosave + finalized on exit). */
  output: string;
  /** Editor binary override. Default: first of nvim, vim on PATH. */
  editor?: string;
  /** Force running in the current terminal even when $TMUX is set. */
  noTmux?: boolean;
}

function shellQuote(s: string): string {
  if (s.length > 0 && /^[a-zA-Z0-9_\-./:@%+=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resolveEditor(override?: string): string {
  const candidates = override ? [override] : ['nvim', 'vim'];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
      if (r.status === 0) return bin;
    } catch {
      // not on PATH — try next
    }
  }
  throw new Error(
    override
      ? `Editor not found or not runnable: ${override}`
      : 'No editor found: install Neovim (nvim) or Vim (vim) — `hl propose` runs the review in your editor.',
  );
}

// The entire review UX as a clean, minimal Vimscript config sourced via `-u`.
// Works in both Neovim and Vim 8+. The source file is opened read-only; the
// human anchors comments to real source lines/selections and quits to submit.
function reviewVimscript(): string {
  return [
    `" hl propose — review layer. Runs on a CLEAN config (nvim -u NONE: no`,
    `" init.lua, no LazyVim, no plugins/keymaps). Look/feel is ONLY the user's`,
    `" 'gloam' colorscheme + built-in treesitter markdown highlighting, applied`,
    `" below. The rest is the read-only guard, comment commands, and autosave.`,
    `let g:hl_out = $HL_OUTPUT`,
    `let g:hl_src = $HL_SOURCE`,
    `let s:comments = []`,
    `let s:idseq = 0`,
    `let s:ns = exists('*nvim_create_namespace') ? nvim_create_namespace('hl_review') : -1`,
    ``,
    `function! s:Load() abort`,
    `  if g:hl_out ==# '' || !filereadable(g:hl_out)`,
    `    return`,
    `  endif`,
    `  try`,
    `    let l:obj = json_decode(join(readfile(g:hl_out), "\\n"))`,
    `    if type(l:obj) == type({}) && get(l:obj,'file','') ==# g:hl_src && !get(l:obj,'submitted',0)`,
    `      let s:comments = get(l:obj,'comments',[])`,
    `    endif`,
    `  catch`,
    `  endtry`,
    `endfunction`,
    ``,
    `function! s:Save() abort`,
    `  let l:obj = {'file': g:hl_src, 'submitted': v:false, 'approved': v:false, 'comments': s:comments, 'savedAt': strftime('%Y-%m-%dT%H:%M:%S')}`,
    `  let l:tmp = g:hl_out . '.tmp'`,
    `  call writefile([json_encode(l:obj)], l:tmp)`,
    `  call rename(l:tmp, g:hl_out)`,
    `endfunction`,
    ``,
    `function! s:Marks() abort`,
    `  silent! sign unplace *`,
    `  if s:ns >= 0`,
    `    call nvim_buf_clear_namespace(0, s:ns, 0, -1)`,
    `  endif`,
    `  let l:sid = 1`,
    `  for l:c in s:comments`,
    `    let l:ln = get(l:c,'line',1)`,
    `    let l:end = get(l:c,'endLine',l:ln)`,
    `    execute 'sign place ' . l:sid . ' line=' . l:ln . ' name=HLgutter buffer=' . bufnr('%')`,
    `    let l:sid += 1`,
    `    let l:cs = get(l:c,'colStart',-1)`,
    `    let l:ce = get(l:c,'colEnd',-1)`,
    `    let l:ranged = 0`,
    `    if s:ns >= 0 && type(l:cs) == type(0) && type(l:ce) == type(0) && l:cs >= 0 && l:ce > l:cs`,
    `      try`,
    `        call nvim_buf_set_extmark(0, s:ns, l:ln - 1, l:cs, {'end_row': l:end - 1, 'end_col': l:ce, 'hl_group': 'HLRange', 'priority': 200})`,
    `        let l:ranged = 1`,
    `      catch`,
    `      endtry`,
    `    endif`,
    `    if !l:ranged`,
    `      let l:k = l:ln`,
    `      while l:k <= l:end`,
    `        execute 'sign place ' . l:sid . ' line=' . l:k . ' name=HLline buffer=' . bufnr('%')`,
    `        let l:sid += 1`,
    `        let l:k += 1`,
    `      endwhile`,
    `    endif`,
    `  endfor`,
    `endfunction`,
    ``,
    `function! s:Comment(mode) abort`,
    `  let l:sz = getreg('z')`,
    `  let l:szt = getregtype('z')`,
    `  let l:cs = -1`,
    `  let l:ce = -1`,
    `  if a:mode ==# 'v'`,
    `    silent! normal! gv"zy`,
    `    let l:vm = visualmode()`,
    `    let l:l1 = line("'<")`,
    `    let l:l2 = line("'>")`,
    `    let l:raw = getreg('z')`,
    `    let l:quote = substitute(l:raw, '\\n\\+$', '', '')`,
    `    if l:vm ==# 'v'`,
    `      let l:segs = split(l:raw, "\\n", 1)`,
    `      let l:cs = col("'<") - 1`,
    `      let l:ce = len(l:segs) <= 1 ? (l:cs + strlen(l:segs[0])) : strlen(l:segs[-1])`,
    `    endif`,
    `  else`,
    `    let l:l1 = line('.')`,
    `    let l:l2 = l:l1`,
    `    let l:quote = ''`,
    `  endif`,
    `  call setreg('z', l:sz, l:szt)`,
    `  let l:label = l:l1 == l:l2 ? ('line ' . l:l1) : ('lines ' . l:l1 . '-' . l:l2)`,
    `  let l:txt = input('Comment on ' . l:label . ': ')`,
    `  redraw`,
    `  if empty(trim(l:txt))`,
    `    echohl WarningMsg | echo 'Comment cancelled' | echohl NONE`,
    `    return`,
    `  endif`,
    `  let s:idseq += 1`,
    `  let l:item = {'id': 'c' . localtime() . s:idseq, 'line': l:l1, 'endLine': l:l2, 'lineText': join(getline(l:l1, l:l2), "\\n"), 'comment': l:txt, 'createdAt': strftime('%Y-%m-%dT%H:%M:%S')}`,
    `  if a:mode ==# 'v' && !empty(l:quote)`,
    `    let l:item['quote'] = l:quote`,
    `  endif`,
    `  if l:cs >= 0 && l:ce > l:cs`,
    `    let l:item['colStart'] = l:cs`,
    `    let l:item['colEnd'] = l:ce`,
    `  endif`,
    `  call add(s:comments, l:item)`,
    `  call s:Save()`,
    `  call s:Marks()`,
    `  echo 'Saved — ' . len(s:comments) . ' comment' . (len(s:comments)==1?'':'s')`,
    `endfunction`,
    ``,
    `function! s:Undo() abort`,
    `  if empty(s:comments)`,
    `    echohl WarningMsg | echo 'No comments to undo' | echohl NONE`,
    `    return`,
    `  endif`,
    `  call remove(s:comments, -1)`,
    `  call s:Save()`,
    `  call s:Marks()`,
    `  echo 'Removed last comment — ' . len(s:comments) . ' left'`,
    `endfunction`,
    ``,
    `function! s:List() abort`,
    `  let l:wid = bufwinid('__HL_Comments__')`,
    `  if l:wid != -1`,
    `    call win_gotoid(l:wid) | close | return`,
    `  endif`,
    `  let l:lines = []`,
    `  if empty(s:comments)`,
    `    let l:lines = ['(no comments yet — select text or put the cursor on a line, then <Space>c  or  :HLComment)']`,
    `  else`,
    `    let l:i = 1`,
    `    for l:c in s:comments`,
    `      let l:ln = get(l:c,'line',0)`,
    `      let l:end = get(l:c,'endLine',l:ln)`,
    `      let l:loc = l:ln == l:end ? ('L' . l:ln) : ('L' . l:ln . '-' . l:end)`,
    `      call add(l:lines, l:i . '. [' . l:loc . ']  ' . get(l:c,'comment',''))`,
    `      if !empty(get(l:c,'quote',''))`,
    `        call add(l:lines, '      > ' . substitute(get(l:c,'quote',''), "\\n", ' / ', 'g'))`,
    `      endif`,
    `      let l:i += 1`,
    `    endfor`,
    `  endif`,
    `  botright 10split __HL_Comments__`,
    `  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted`,
    `  setlocal nonumber nocursorline winfixheight signcolumn=no`,
    `  setlocal modifiable`,
    `  call setline(1, l:lines)`,
    `  setlocal nomodifiable`,
    `  nnoremap <buffer> <silent> q :close<CR>`,
    `  nnoremap <buffer> <silent> <Space>l :close<CR>`,
    `endfunction`,
    ``,
    `function! s:Submit() abort`,
    `  call s:Save()`,
    `  qa!`,
    `endfunction`,
    ``,
    `command! HLComment call <SID>Comment('n')`,
    `command! HLList call <SID>List()`,
    `command! HLUndo call <SID>Undo()`,
    `command! HLSubmit call <SID>Submit()`,
    `command! HLHelp echo 'REVIEW  <Space>c comment (visual or line)   <Space>l list   <Space>u undo-last   <Space>s submit & quit   — or :HLComment/:HLList/:HLUndo/:HLSubmit   (any quit submits)'`,
    ``,
    `" Highlights are (re)applied after any colorscheme so the user's theme`,
    `" (e.g. gloam) loads first, then our anchor highlight sits on top.`,
    `function! s:Hi() abort`,
    `  sign define HLgutter text=>> texthl=HLSign`,
    `  sign define HLline linehl=HLLine`,
    `  hi! HLSign ctermfg=178 guifg=#d7af00`,
    `  hi! HLLine ctermbg=229 guibg=#fff3bf guifg=#3a2f00`,
    `  hi! HLRange ctermbg=222 guibg=#ffe066 guifg=#1c1500`,
    `endfunction`,
    `call s:Hi()`,
    `autocmd ColorScheme * call s:Hi()`,
    `" Load ONLY the user's colorscheme: self-contained at`,
    `" ~/.config/nvim/colors/gloam.lua, needs no plugins, and -u NONE keeps the`,
    `" config dir on runtimepath so it resolves. Fires ColorScheme, so the`,
    `" autocmd above reapplies our anchor highlights on top of gloam.`,
    `silent! colorscheme gloam`,
    ``,
    `function! s:Setup() abort`,
    `  " Read-only guard so review never mutates the source doc.`,
    `  setlocal nomodifiable`,
    `  setlocal signcolumn=yes`,
    `  if &filetype !=# 'markdown' | setlocal filetype=markdown | endif`,
    `  " gloam only defines treesitter @markup.* highlight groups for markdown,`,
    `  " so the styling needs treesitter active. Built-in treesitter plus the`,
    `  " site-dir markdown parser render it with zero plugins.`,
    `  if has('nvim')`,
    `    silent! lua pcall(vim.treesitter.start, 0, 'markdown')`,
    `  endif`,
    `  " Buffer-local <Space> maps. Clean config has no which-key/<leader>`,
    `  " bindings to collide with, and these are gone outside this buffer.`,
    `  vnoremap <buffer> <silent> <Space>c :<C-u>call <SID>Comment('v')<CR>`,
    `  nnoremap <buffer> <silent> <Space>c :call <SID>Comment('n')<CR>`,
    `  nnoremap <buffer> <silent> <Space>l :call <SID>List()<CR>`,
    `  nnoremap <buffer> <silent> <Space>u :call <SID>Undo()<CR>`,
    `  nnoremap <buffer> <silent> <Space>s :call <SID>Submit()<CR>`,
    `  call s:Hi()`,
    `  call s:Load()`,
    `  call s:Marks()`,
    `  redraw`,
    `  echohl Question | echo 'hl review — <Space>c comment   <Space>l list   <Space>u undo   <Space>s submit & quit   (:HLHelp)' | echohl NONE`,
    `endfunction`,
    `autocmd VimEnter * call s:Setup()`,
    `autocmd VimLeavePre * call s:Save()`,
    ``,
  ].join('\n');
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function sanitizeComments(raw: unknown): FeedbackComment[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedbackComment[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const c = r as Record<string, unknown>;
    const comment = typeof c.comment === 'string' ? c.comment.trim() : '';
    if (!comment) continue;
    const line = Number(c.line) || 1;
    const endLine = Number(c.endLine) || line;
    const colStart = Number.isInteger(c.colStart) ? (c.colStart as number) : undefined;
    const colEnd = Number.isInteger(c.colEnd) ? (c.colEnd as number) : undefined;
    out.push({
      id: typeof c.id === 'string' && c.id ? c.id : `c${out.length}`,
      line,
      endLine,
      colStart: colStart !== undefined && colEnd !== undefined && colEnd > colStart ? colStart : undefined,
      colEnd: colStart !== undefined && colEnd !== undefined && colEnd > colStart ? colEnd : undefined,
      quote: typeof c.quote === 'string' && c.quote ? c.quote : undefined,
      lineText: typeof c.lineText === 'string' ? c.lineText : '',
      comment,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date().toISOString(),
    });
  }
  return out;
}

const FEEDBACK_SCHEMA =
  '{file, submitted, approved, comments:[{id, line, endLine, quote?, colStart?, colEnd?, lineText, comment, createdAt}], submittedAt, savedAt}';

function rangeLabel(c: FeedbackComment): string {
  const cols = Number.isInteger(c.colStart) && Number.isInteger(c.colEnd);
  if (c.line === c.endLine) {
    return cols ? `L${c.line}:${c.colStart}-${c.colEnd}` : `L${c.line}`;
  }
  return cols ? `L${c.line}:${c.colStart}-${c.endLine}:${c.colEnd}` : `L${c.line}-${c.endLine}`;
}

/**
 * Compact stdout rendering for the agent: per comment just the line:col
 * range, the original text in that span, and the note — plus the source
 * path, a pointer to the full JSON on disk, and a one-line schema hint.
 * The verbose fields are deliberately not printed so they don't clog context.
 */
export function formatFeedbackSummary(result: FeedbackResult, feedbackJsonPath: string): string {
  const n = result.comments.length;
  const out: string[] = [];
  if (n === 0) {
    out.push(`hl propose — approved: 0 comments on ${result.file} (human signalled looks-good; proceed)`);
  } else {
    out.push(`hl propose — ${n} comment${n === 1 ? '' : 's'} on ${result.file}`);
    out.push('');
    result.comments.forEach((c, i) => {
      const original = c.quote && c.quote.length > 0 ? c.quote : c.lineText;
      const lines = original.split('\n');
      out.push(` ${i + 1}. ${rangeLabel(c)}`);
      lines.forEach((ln, k) => out.push(k === 0 ? `    text:    ${ln}` : `             ${ln}`));
      out.push(`    comment: ${c.comment}`);
      out.push('');
    });
  }
  out.push(`Full record → ${feedbackJsonPath}  (other fields rarely needed)`);
  out.push(`  schema: ${FEEDBACK_SCHEMA}  · cols are 0-based byte offsets, colEnd exclusive`);
  return out.join('\n');
}

async function runInTmuxPane(paneCmd: string): Promise<void> {
  // `paneCmd` MUST be an `exec`-prefixed command so the editor replaces the
  // shell and becomes the pane's process. tmux's `#{pane_current_command}`
  // then reports `nvim` — many users gate "let Ctrl-D/Ctrl-U/etc. through to
  // the app vs. take over with tmux copy-mode" on exactly that. If the pane
  // command were `nvim …; tmux wait-for` the pane process stays the shell,
  // pane_current_command is `zsh`/`sh`, and those bindings hijack native vim
  // keys. Because the editor is exec'd there is no "after" to signal from, so
  // completion is detected purely by the pane disappearing on exit.
  const paneId = execFileSync(
    'tmux',
    ['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', paneCmd],
    { encoding: 'utf8' },
  ).trim();
  // Ensure the pane closes when the editor exits (some configs set
  // remain-on-exit globally, which would hang the poll below).
  try {
    execFileSync('tmux', ['set-option', '-p', '-t', paneId, 'remain-on-exit', 'off'], { stdio: 'ignore' });
  } catch {
    // older tmux without -p pane scope — default is already 'off'
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearInterval(poll); fn(); } };

    // The editor IS the pane process; when it exits the pane is destroyed.
    const poll = setInterval(() => {
      try {
        const panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' });
        if (!panes.split('\n').map((s) => s.trim()).includes(paneId)) {
          finish(resolvePromise);
        }
      } catch (e) {
        finish(() => rejectPromise(new Error(`tmux list-panes failed: ${e instanceof Error ? e.message : String(e)}`)));
      }
    }, 200);
  });
}

function runInCurrentTerminal(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    child.on('error', rejectPromise);
    child.on('exit', () => resolvePromise());
  });
}

/**
 * Open a markdown file in a clean, read-only Neovim/Vim review session. The
 * human anchors comments to source lines/selections with native vim motions
 * and quits to submit. Blocks until the editor exits, then finalizes and
 * returns the feedback. Autosaved continuously so a kill is recoverable and
 * the next run resumes.
 */
export async function launchReview(file: string, opts: ReviewOptions): Promise<FeedbackResult> {
  const absFile = resolve(file);
  if (!existsSync(absFile)) {
    throw new Error(`Markdown file not found: ${absFile}`);
  }
  const outPath = resolve(opts.output);
  const bin = resolveEditor(opts.editor);

  const dir = mkdtempSync(join(tmpdir(), 'hl-review-'));
  const initPath = join(dir, 'review.vim');
  writeFileSync(initPath, reviewVimscript());

  const env: NodeJS.ProcessEnv = { ...process.env, HL_OUTPUT: outPath, HL_SOURCE: absFile };
  // `-u NONE`: do NOT load the user's init.lua / LazyVim / plugins / keymaps.
  // Default runtimepath still includes the config dir (for the gloam
  // colorscheme) and the site dir (for the treesitter markdown parser), so the
  // review layer pulls in ONLY the colorscheme + treesitter styling itself.
  const editorArgs = ['-u', 'NONE', '-n', '-i', 'NONE', absFile, '-c', `source ${initPath}`];

  const inTmux = !!process.env.TMUX && !opts.noTmux;
  process.stderr.write(
    `\nhumanloop: opening "${absFile}" for review in ${bin}` +
    (inTmux ? ' (tmux pane).\n' : '.\n') +
    `  Answers : ${outPath}\n` +
    `  Keys    : <Space>c comment · <Space>l list · <Space>u undo · <Space>s submit & quit  (or :HLComment/:HLSubmit)\n` +
    `  Status  : BLOCKING — waiting for you to finish the review and quit the editor.\n\n`,
  );

  if (inTmux) {
    // `exec env …` so the editor replaces the shell and becomes the pane's
    // process (so tmux `#{pane_current_command}` is `nvim`, not the shell).
    const paneCmd = [
      'exec',
      'env',
      `HL_OUTPUT=${shellQuote(outPath)}`,
      `HL_SOURCE=${shellQuote(absFile)}`,
      shellQuote(bin),
      ...editorArgs.map(shellQuote),
    ].join(' ');
    try {
      await runInTmuxPane(paneCmd);
    } catch (err) {
      process.stderr.write(`tmux dispatch failed, running in current terminal: ${err instanceof Error ? err.message : String(err)}\n`);
      await runInCurrentTerminal(bin, editorArgs, env);
    }
  } else {
    await runInCurrentTerminal(bin, editorArgs, env);
  }

  let comments: FeedbackComment[] = [];
  if (existsSync(outPath)) {
    try {
      const prior = JSON.parse(readFileSync(outPath, 'utf8')) as { comments?: unknown };
      comments = sanitizeComments(prior.comments);
    } catch {
      // unreadable autosave — treat as no comments rather than failing the run
    }
  }

  const now = new Date().toISOString();
  const result: FeedbackResult = {
    file: absFile,
    submitted: true,
    approved: comments.length === 0,
    comments,
    submittedAt: now,
    savedAt: now,
  };
  atomicWrite(outPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}
