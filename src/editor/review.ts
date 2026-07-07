import { spawn, spawnSync, execFileSync } from 'child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import type { FeedbackComment, FeedbackResult } from '../types.js';
import { openBrowser } from '../browser/open.js';
import { startReviewWebServer, type WebServerHandle } from '../browser/server.js';
import {
  readStoredFeedbackResult,
  writeDraftFeedbackResult,
  writeFinalFeedbackResult,
} from './feedback.js';

export interface ReviewOptions {
  /** Where the answers JSON is written (live autosave + finalized on exit). */
  output: string;
  /** Editor binary override. Default: first of nvim, vim on PATH. */
  editor?: string;
  /** Force running in the current terminal even when $TMUX is set. */
  noTmux?: boolean;
  /**
   * When set, an explicit `<Space>s` / `:HLSubmit` invocation writes a sentinel
   * file at this path. Node-side uses the file's existence to gate `submitted: true`.
   * When omitted, any editor exit finalizes `submitted: true` (legacy behavior).
   */
  submitFlagPath?: string;
  /**
   * When true and $TMUX is set and !opts.noTmux, launch via
   * `tmux display-popup -E` instead of `tmux split-window`.
   * display-popup -E is synchronous so no poll loop is needed.
   */
  tmuxPopup?: boolean;
  /** Override the default 90%/90% popup size. Only used when tmuxPopup is true. */
  popupSize?: { w: string; h: string };
  /**
   * Reuse this directory for `review.vim` instead of minting a fresh temp dir.
   * The async `review open` kickoff passes its job dir so the detached child
   * sources the same vimscript the parent already wrote there (which also lets
   * the job be recognized as a review while it's still live). When the file
   * already exists it is left untouched.
   */
  jobDir?: string;
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
export function reviewVimscript(): string {
  return [
    `" hl propose — review layer. Runs on a CLEAN config (nvim -u NONE: no`,
    `" init.lua, no LazyVim, no plugins/keymaps). Look/feel is ONLY the user's`,
    `" 'gloam' colorscheme + built-in treesitter markdown highlighting + (when`,
    `" installed) render-markdown.nvim for GFM tables/headings, applied below.`,
    `" The rest is the read-only guard, comment commands, and autosave.`,
    `let g:hl_out = $HL_OUTPUT`,
    `let g:hl_src = $HL_SOURCE`,
    `let g:hl_review_url = $HL_REVIEW_URL`,
    `let g:hl_handoff_flag = $HL_HANDOFF_FLAG`,
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
    `  call s:OpenInput('Comment on ' . l:label, '', function('s:CommentSave', [l:l1, l:l2, l:quote, l:cs, l:ce, a:mode]))`,
    `endfunction`,
    ``,
    `" Persist a comment once the input buffer is submitted. Bound args carry the`,
    `" anchor (line range, quote, col span, mode) captured before the prompt`,
    `" opened; a:txt is the (possibly multi-line) comment body.`,
    `function! s:CommentSave(l1, l2, quote, cs, ce, mode, txt) abort`,
    `  if empty(trim(a:txt))`,
    `    echohl WarningMsg | echo 'Comment cancelled' | echohl NONE`,
    `    return`,
    `  endif`,
    `  let s:idseq += 1`,
    `  let l:item = {'id': 'c' . localtime() . s:idseq, 'line': a:l1, 'endLine': a:l2, 'lineText': join(getline(a:l1, a:l2), "\\n"), 'comment': a:txt, 'createdAt': strftime('%Y-%m-%dT%H:%M:%S')}`,
    `  if a:mode ==# 'v' && !empty(a:quote)`,
    `    let l:item['quote'] = a:quote`,
    `  endif`,
    `  if a:cs >= 0 && a:ce > a:cs`,
    `    let l:item['colStart'] = a:cs`,
    `    let l:item['colEnd'] = a:ce`,
    `  endif`,
    `  call add(s:comments, l:item)`,
    `  call s:Save()`,
    `  call s:Marks()`,
    `  echo 'Saved — ' . len(s:comments) . ' comment' . (len(s:comments)==1?'':'s')`,
    `endfunction`,
    ``,
    `" Multi-line comment entry. Vim's input() is single-line: a long comment`,
    `" overflows the cmdline and Vim re-echoes the prompt on every wrapped row,`,
    `" cascading it down the screen. So comments are typed in a real scratch`,
    `" buffer that wraps naturally and accepts newlines. a:Cb is invoked with the`,
    `" buffer text on submit; cancel (or empty submit) just closes.`,
    `function! s:OpenInput(title, default, Cb) abort`,
    `  let l:rw = win_getid()`,
    `  botright 8new`,
    `  let b:hl_cb = a:Cb`,
    `  let b:hl_rw = l:rw`,
    `  let b:hl_done = 0`,
    `  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted`,
    `  setlocal nonumber winfixheight wrap linebreak signcolumn=no`,
    `  if !empty(a:default)`,
    `    call setline(1, split(a:default, "\\n", 1))`,
    `  endif`,
    `  let &l:statusline = ' ' . a:title . '    Ctrl-S / <Space>s submit · Ctrl-C / q cancel '`,
    `  nnoremap <buffer> <silent> <C-s> :call <SID>InputSubmit()<CR>`,
    `  inoremap <buffer> <silent> <C-s> <Esc>:call <SID>InputSubmit()<CR>`,
    `  nnoremap <buffer> <silent> <Space>s :call <SID>InputSubmit()<CR>`,
    `  nnoremap <buffer> <silent> <C-c> :call <SID>InputCancel()<CR>`,
    `  inoremap <buffer> <silent> <C-c> <Esc>:call <SID>InputCancel()<CR>`,
    `  nnoremap <buffer> <silent> q :call <SID>InputCancel()<CR>`,
    `  if !empty(a:default)`,
    `    call cursor(line('$'), 1)`,
    `    startinsert!`,
    `  else`,
    `    startinsert`,
    `  endif`,
    `endfunction`,
    ``,
    `function! s:InputSubmit() abort`,
    `  if get(b:, 'hl_done', 0) | return | endif`,
    `  let b:hl_done = 1`,
    `  let l:txt = join(getline(1, '$'), "\\n")`,
    `  let l:Cb = b:hl_cb`,
    `  let l:rw = b:hl_rw`,
    `  close!`,
    `  call win_gotoid(l:rw)`,
    `  call l:Cb(l:txt)`,
    `endfunction`,
    ``,
    `function! s:InputCancel() abort`,
    `  if get(b:, 'hl_done', 0) | return | endif`,
    `  let b:hl_done = 1`,
    `  let l:rw = b:hl_rw`,
    `  close!`,
    `  call win_gotoid(l:rw)`,
    `  redraw`,
    `  echohl WarningMsg | echo 'Cancelled' | echohl NONE`,
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
    `" Build the list buffer lines plus a parallel map from buffer line -> comment`,
    `" index (0-based; -1 for non-actionable rows like the quote continuation or`,
    `" the empty-state hint). Stored on the buffer so the action maps can resolve`,
    `" which comment the cursor is on.`,
    `function! s:ListLines() abort`,
    `  let l:lines = []`,
    `  let l:map = []`,
    `  if empty(s:comments)`,
    `    call add(l:lines, '(no comments yet — select text or put the cursor on a line, then <Space>c  or  :HLComment)')`,
    `    call add(l:map, -1)`,
    `  else`,
    `    let l:idx = 0`,
    `    for l:c in s:comments`,
    `      let l:ln = get(l:c,'line',0)`,
    `      let l:end = get(l:c,'endLine',l:ln)`,
    `      let l:loc = l:ln == l:end ? ('L' . l:ln) : ('L' . l:ln . '-' . l:end)`,
    `      call add(l:lines, (l:idx+1) . '. [' . l:loc . ']  ' . substitute(get(l:c,'comment',''), "\\n", ' / ', 'g'))`,
    `      call add(l:map, l:idx)`,
    `      if !empty(get(l:c,'quote',''))`,
    `        call add(l:lines, '      > ' . substitute(get(l:c,'quote',''), "\\n", ' / ', 'g'))`,
    `        call add(l:map, l:idx)`,
    `      endif`,
    `      let l:idx += 1`,
    `    endfor`,
    `  endif`,
    `  return [l:lines, l:map]`,
    `endfunction`,
    ``,
    `" Refill the (already-open) comments buffer in place and refresh the line map.`,
    `function! s:RenderList() abort`,
    `  let [l:lines, l:map] = s:ListLines()`,
    `  let b:hl_map = l:map`,
    `  setlocal modifiable`,
    `  silent! 1,$delete _`,
    `  call setline(1, l:lines)`,
    `  setlocal nomodifiable`,
    `endfunction`,
    ``,
    `" Comment index (0-based) under the cursor in the comments buffer, or -1.`,
    `function! s:ListIdx() abort`,
    `  if !exists('b:hl_map') | return -1 | endif`,
    `  let l:lnum = line('.')`,
    `  if l:lnum < 1 || l:lnum > len(b:hl_map) | return -1 | endif`,
    `  return b:hl_map[l:lnum - 1]`,
    `endfunction`,
    ``,
    `function! s:ListDelete() abort`,
    `  let l:idx = s:ListIdx()`,
    `  if l:idx < 0`,
    `    echohl WarningMsg | echo 'No comment on this line' | echohl NONE | return`,
    `  endif`,
    `  call remove(s:comments, l:idx)`,
    `  call s:Save()`,
    `  call s:Marks()`,
    `  call s:RenderList()`,
    `  echo 'Deleted comment — ' . len(s:comments) . ' left'`,
    `endfunction`,
    ``,
    `function! s:ListEdit() abort`,
    `  let l:idx = s:ListIdx()`,
    `  if l:idx < 0`,
    `    echohl WarningMsg | echo 'No comment on this line' | echohl NONE | return`,
    `  endif`,
    `  let l:cur = get(s:comments[l:idx], 'comment', '')`,
    `  call s:OpenInput('Edit comment', l:cur, function('s:ListEditSave', [l:idx]))`,
    `endfunction`,
    ``,
    `function! s:ListEditSave(idx, txt) abort`,
    `  if empty(trim(a:txt))`,
    `    echohl WarningMsg | echo 'Edit cancelled — comment unchanged' | echohl NONE | return`,
    `  endif`,
    `  let s:comments[a:idx]['comment'] = a:txt`,
    `  call s:Save()`,
    `  call s:RenderList()`,
    `  echo 'Updated comment'`,
    `endfunction`,
    ``,
    `function! s:List() abort`,
    `  let l:wid = bufwinid('__HL_Comments__')`,
    `  if l:wid != -1`,
    `    call win_gotoid(l:wid) | close | return`,
    `  endif`,
    `  botright 10split __HL_Comments__`,
    `  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted`,
    `  setlocal nonumber cursorline winfixheight signcolumn=no`,
    `  call s:RenderList()`,
    `  nnoremap <buffer> <silent> q :close<CR>`,
    `  nnoremap <buffer> <silent> <Space>l :close<CR>`,
    `  nnoremap <buffer> <silent> dd :call <SID>ListDelete()<CR>`,
    `  nnoremap <buffer> <silent> e :call <SID>ListEdit()<CR>`,
    `  nnoremap <buffer> <silent> <CR> :call <SID>ListEdit()<CR>`,
    `  echohl Question | echo 'list — e/<CR> edit · dd delete · q/<Space>l close' | echohl NONE`,
    `endfunction`,
    ``,
    `function! s:Submit() abort`,
    `  call s:Save()`,
    `  if $HL_SUBMIT_FLAG !=# ''`,
    `    call writefile([''], $HL_SUBMIT_FLAG)`,
    `  endif`,
    `  qa!`,
    `endfunction`,
    ``,
    `function! s:HandOff() abort`,
    `  call s:Save()`,
    `  if g:hl_handoff_flag ==# ''`,
    `    echohl ErrorMsg | echo 'Browser handoff unavailable' | echohl NONE`,
    `    return`,
    `  endif`,
    `  call writefile([''], g:hl_handoff_flag)`,
    `  qa!`,
    `endfunction`,
    ``,
    `command! HLComment call <SID>Comment('n')`,
    `command! HLList call <SID>List()`,
    `command! HLUndo call <SID>Undo()`,
    `command! HLSubmit call <SID>Submit()`,
    `command! HLBrowser call <SID>HandOff()`,
    `command! HLHelp echo 'REVIEW  <Space>c comment   <Space>l list   <Space>u undo-last   <Space>s submit & quit   <Space>w browser handoff   |  in list: e/<CR> edit · dd delete · q close'`,
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
    `" Cursor visibility: -u NONE loads nvim's built-in guicursor, which forces a`,
    `" steady-block DECSCUSR (ESC[2 q). Under tmux-256color no cursor COLOR is sent`,
    `" (terminfo lacks Cs/Cr), so the block inherits the terminal's profile cursor`,
    `" color — which renders invisibly in some terminals (e.g. iTerm2 on a dark`,
    `" theme). Emptying guicursor tells nvim to stop managing cursor shape/color, so`,
    `" the review shows the SAME native, visible cursor as a normal shell.`,
    `set guicursor=`,
    ``,
    `function! s:Setup() abort`,
    `  " Read-only guard so review never mutates the source doc.`,
    `  setlocal nomodifiable`,
    `  setlocal signcolumn=yes`,
    `  if &filetype !=# 'markdown' | setlocal filetype=markdown | endif`,
    `  " gloam only defines treesitter @markup.* highlight groups for markdown,`,
    `  " so the styling needs treesitter active. Built-in treesitter plus the`,
    `  " site-dir markdown parser render it with zero plugins. When the user has`,
    `  " render-markdown.nvim installed (lazy dir / packpath), pull it in too so`,
    `  " GFM tables and headings render the same as their normal editor — it only`,
    `  " draws extmarks/conceal, so the read-only buffer text (and the line:col`,
    `  " anchors comments hang off of) is never touched.`,
    `  if has('nvim')`,
    `    silent! lua << HLLUA`,
    `pcall(vim.treesitter.start, 0, 'markdown')`,
    `pcall(function()`,
    `  local path = vim.fn.stdpath('data') .. '/lazy/render-markdown.nvim'`,
    `  if vim.fn.isdirectory(path) == 0 then`,
    `    local hits = vim.fn.globpath(vim.o.packpath, '*/*/render-markdown.nvim', false, true)`,
    `    path = hits[1]`,
    `  end`,
    `  if not path or vim.fn.isdirectory(path) == 0 then return end`,
    `  vim.opt.runtimepath:prepend(path)`,
    `  vim.g.render_markdown_config = {`,
    `    file_types = { 'markdown' },`,
    `    completions = { lsp = { enabled = false } },`,
    `    heading = { border = false },`,
    `  }`,
    `  vim.cmd('silent! runtime plugin/render-markdown.lua')`,
    `  -- Defer the initial paint to the next tick: during VimEnter the window`,
    `  -- isn't laid out yet, so an immediate render no-ops and tables show raw`,
    `  -- until the first cursor move. api.render() forces a paint for the`,
    `  -- buffer's window (the live autocmds the plugin installed keep it updated`,
    `  -- on edits/scroll thereafter). render-markdown refuses to draw while a`,
    `  -- prompt mode is active ('r' hit-enter, 'rm' more, 'r?' confirm) — e.g. a`,
    `  -- wrapped :echo — so re-defer until we're back in a normal state.`,
    `  local function paint()`,
    `    local m = vim.api.nvim_get_mode().mode`,
    `    if m == 'r' or m == 'rm' or m == 'r?' then`,
    `      vim.defer_fn(paint, 60)`,
    `      return`,
    `    end`,
    `    pcall(function()`,
    `      require('render-markdown.api').render({`,
    `        buf = vim.api.nvim_get_current_buf(),`,
    `        win = vim.api.nvim_get_current_win(),`,
    `      })`,
    `    end)`,
    `  end`,
    `  vim.schedule(paint)`,
    `end)`,
    `HLLUA`,
    `  endif`,
    `  " Buffer-local <Space> maps. Clean config has no which-key/<leader>`,
    `  " bindings to collide with, and these are gone outside this buffer.`,
    `  vnoremap <buffer> <silent> <Space>c :<C-u>call <SID>Comment('v')<CR>`,
    `  nnoremap <buffer> <silent> <Space>c :call <SID>Comment('n')<CR>`,
    `  nnoremap <buffer> <silent> <Space>l :call <SID>List()<CR>`,
    `  nnoremap <buffer> <silent> <Space>u :call <SID>Undo()<CR>`,
    `  nnoremap <buffer> <silent> <Space>s :call <SID>Submit()<CR>`,
    `  nnoremap <buffer> <silent> <Space>w :call <SID>HandOff()<CR>`,
    `  call s:Hi()`,
    `  call s:Load()`,
    `  call s:Marks()`,
    `  redraw`,
    `  " Keep this hint short: a line that wraps past the cmdline triggers the`,
    `  " hit-enter prompt, whose mode blocks the deferred render-markdown paint.`,
    `  " The full key list lives in :HLHelp (and is printed to stderr on launch).`,
    `  echohl Question | echo 'hl review — c comment · l list · u undo · s submit · w browser  (:HLHelp)' | echohl NONE`,
    `endfunction`,
    `autocmd VimEnter * call s:Setup()`,
    `autocmd VimLeavePre * call s:Save()`,
    ``,
    `" Watchmode: the source is opened read-only here but may be rewritten on`,
    `" disk by the agent while the human reviews. autoread + a periodic checktime`,
    `" (timers fire even when the tmux pane is unfocused) reload the buffer`,
    `" silently — it is never locally modified, so there is nothing to clobber.`,
    `" On reload, re-run Setup (read-only guard, treesitter, maps) and redraw the`,
    `" comment anchors, which the reload cleared. Comments live in s:comments /`,
    `" the autosave file, not the buffer, so they survive; their line anchors may`,
    `" drift if the edit moved text, which is expected — the human sees the latest.`,
    `set autoread`,
    `autocmd FocusGained,BufEnter,CursorHold * silent! checktime`,
    `autocmd FileChangedShellPost * call s:Setup() | call s:Marks() | redraw`,
    `if exists('*timer_start')`,
    `  let s:hl_watch = timer_start(1000, {-> execute('silent! checktime')}, {'repeat': -1})`,
    `endif`,
    ``,
  ].join('\n');
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
  if (!result.submitted) {
    if (n > 0) {
      out.push(`hl propose — draft saved: ${n} comment${n === 1 ? '' : 's'} on ${result.file} (not yet submitted)`);
      out.push('');
      result.comments.forEach((c, i) => {
        const original = c.quote && c.quote.length > 0 ? c.quote : c.lineText;
        const lines = original.split('\n');
        out.push(` ${i + 1}. ${rangeLabel(c)}`);
        lines.forEach((ln, k) => out.push(k === 0 ? `    text:    ${ln}` : `             ${ln}`));
        c.comment.split('\n').forEach((ln, k) => out.push(k === 0 ? `    comment: ${ln}` : `             ${ln}`));
        out.push('');
      });
    } else {
      out.push(`hl propose — draft saved: no comments yet on ${result.file}`);
    }
  } else if (n === 0) {
    out.push(`hl propose — approved: 0 comments on ${result.file} (human signalled looks-good; proceed)`);
  } else {
    out.push(`hl propose — ${n} comment${n === 1 ? '' : 's'} on ${result.file}`);
    out.push('');
    result.comments.forEach((c, i) => {
      const original = c.quote && c.quote.length > 0 ? c.quote : c.lineText;
      const lines = original.split('\n');
      out.push(` ${i + 1}. ${rangeLabel(c)}`);
      lines.forEach((ln, k) => out.push(k === 0 ? `    text:    ${ln}` : `             ${ln}`));
      c.comment.split('\n').forEach((ln, k) => out.push(k === 0 ? `    comment: ${ln}` : `             ${ln}`));
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

type ParkedReviewAction =
  | { type: 'submitted'; result: FeedbackResult }
  | { type: 'take-back' }
  | { type: 'cancel' };

function clearFlag(path: string): void {
  rmSync(path, { force: true });
}

function readDraftComments(path: string, absFile: string): FeedbackComment[] {
  const stored = readStoredFeedbackResult(path, absFile);
  return stored?.comments ?? [];
}

function finalizeReviewOutput(outPath: string, absFile: string, didSubmit: boolean): FeedbackResult {
  const comments = readDraftComments(outPath, absFile);
  return didSubmit
    ? writeFinalFeedbackResult(outPath, absFile, comments)
    : writeDraftFeedbackResult(outPath, absFile, comments);
}

async function waitForParkedReviewSubmit(submitted: Promise<FeedbackResult>): Promise<ParkedReviewAction> {
  process.stderr.write(
    '\nhumanloop: browser review handoff is active.\n' +
    '  The terminal editor is parked; the browser is the editing authority.\n' +
    '  Press w to take back into nvim, or Ctrl+C to exit with an unsubmitted draft.\n\n',
  );

  if (!process.stdin.isTTY) {
    const result = await submitted;
    return { type: 'submitted', result };
  }

  return new Promise<ParkedReviewAction>((resolveAction) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let settled = false;
    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const finish = (action: ParkedReviewAction) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveAction(action);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text === 'w' || text === 'W') finish({ type: 'take-back' });
      if (text === '\u0003') finish({ type: 'cancel' });
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    submitted.then(
      (result) => finish({ type: 'submitted', result }),
      () => finish({ type: 'cancel' }),
    );
  });
}

async function stopReviewServer(handle: WebServerHandle | null): Promise<void> {
  if (handle !== null) await handle.stop();
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

  // When the async kickoff passes its job dir, source the review.vim the parent
  // already wrote there; otherwise mint a private temp dir as before.
  const dir = opts.jobDir ?? mkdtempSync(join(tmpdir(), 'hl-review-'));
  const initPath = join(dir, 'review.vim');
  if (!existsSync(initPath)) writeFileSync(initPath, reviewVimscript());

  const handoffFlagPath = join(dir, 'browser-handoff.flag');
  // `-u NONE`: do NOT load the user's init.lua / LazyVim / plugins / keymaps.
  // Default runtimepath still includes the config dir (for the gloam
  // colorscheme) and the site dir (for the treesitter markdown parser), so the
  // review layer pulls in ONLY the colorscheme + treesitter styling itself.
  const editorArgs = ['-u', 'NONE', '-n', '-i', 'NONE', absFile, '-c', `source ${initPath}`];
  const inTmux = !!process.env.TMUX && !opts.noTmux;

  async function runEditor(reviewUrl: string): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HL_OUTPUT: outPath,
      HL_SOURCE: absFile,
      HL_REVIEW_URL: reviewUrl,
      HL_HANDOFF_FLAG: handoffFlagPath,
      ...(opts.submitFlagPath ? { HL_SUBMIT_FLAG: opts.submitFlagPath } : {}),
    };

    process.stderr.write(
      `\nhumanloop: opening "${absFile}" for review in ${bin}` +
      (inTmux ? ' (tmux pane).\n' : '.\n') +
      `  Answers : ${outPath}\n` +
      `  Browser : ${reviewUrl}  (<Space>w hands off)\n` +
      `  Keys    : <Space>c comment · <Space>l list · <Space>u undo · <Space>s submit & quit · <Space>w browser  (or :HLComment/:HLSubmit/:HLBrowser)\n` +
      `  Status  : BLOCKING — waiting for you to finish the review.\n\n`,
    );

    if (inTmux) {
      // `exec env …` so the editor replaces the shell and becomes the pane's
      // process (so tmux `#{pane_current_command}` is `nvim`, not the shell).
      const envPairs = [
        `HL_OUTPUT=${shellQuote(outPath)}`,
        `HL_SOURCE=${shellQuote(absFile)}`,
        `HL_REVIEW_URL=${shellQuote(reviewUrl)}`,
        `HL_HANDOFF_FLAG=${shellQuote(handoffFlagPath)}`,
        ...(opts.submitFlagPath ? [`HL_SUBMIT_FLAG=${shellQuote(opts.submitFlagPath)}`] : []),
      ];
      const paneCmd = [
        'exec',
        'env',
        ...envPairs,
        shellQuote(bin),
        ...editorArgs.map(shellQuote),
      ].join(' ');
      try {
        if (opts.tmuxPopup) {
          const w = opts.popupSize ? opts.popupSize.w : '90%';
          const h = opts.popupSize ? opts.popupSize.h : '90%';
          execFileSync('tmux', ['display-popup', '-E', '-w', w, '-h', h, paneCmd], { stdio: 'inherit' });
        } else {
          await runInTmuxPane(paneCmd);
        }
      } catch (err) {
        process.stderr.write(`tmux dispatch failed, running in current terminal: ${err instanceof Error ? err.message : String(err)}\n`);
        await runInCurrentTerminal(bin, editorArgs, env);
      }
    } else {
      await runInCurrentTerminal(bin, editorArgs, env);
    }
  }

  while (true) {
    clearFlag(handoffFlagPath);
    let resolveSubmitted!: (result: FeedbackResult) => void;
    const submitted = new Promise<FeedbackResult>((resolveSubmittedPromise) => {
      resolveSubmitted = resolveSubmittedPromise;
    });
    const server = await startReviewWebServer({
      jobDir: dir,
      file: absFile,
      output: outPath,
      submitFlagPath: opts.submitFlagPath,
      onSubmit: (result) => resolveSubmitted(result),
    });

    try {
      await runEditor(server.url);

      if (existsSync(handoffFlagPath)) {
        openBrowser(server.url);
        const action = await waitForParkedReviewSubmit(submitted);
        if (action.type === 'submitted') {
          await stopReviewServer(server);
          clearFlag(handoffFlagPath);
          return action.result;
        }
        if (action.type === 'take-back') {
          server.notifyTakenBack();
          await stopReviewServer(server);
          clearFlag(handoffFlagPath);
          process.stderr.write('humanloop: taking review back into the terminal editor.\n');
          continue;
        }
        await stopReviewServer(server);
        clearFlag(handoffFlagPath);
        return finalizeReviewOutput(outPath, absFile, false);
      }

      await stopReviewServer(server);
      const didSubmit = opts.submitFlagPath ? existsSync(opts.submitFlagPath) : true;
      return finalizeReviewOutput(outPath, absFile, didSubmit);
    } catch (err) {
      await stopReviewServer(server);
      throw err;
    }
  }
}
