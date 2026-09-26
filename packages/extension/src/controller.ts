import { userInfo } from 'node:os';
import * as vscode from 'vscode';
import { buildAnchorContext, type Anchor, type ThreadState } from '@local-review/core';
import { ensureExcluded, gitUserName } from './git';
import type { Log } from './log';
import { toLineRange } from './range';
import { applyThreadState, threadRange, type RenderContext } from './render';
import { Roots, type Root } from './roots';

export const CONTROLLER_ID = 'local-review';

interface Managed {
  state: ThreadState;
  root: Root;
  thread: vscode.CommentThread;
}

/** Owns the comment controller and keeps VS Code threads in sync with the stores. */
export class ReviewController implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly roots = new Roots();
  private readonly managed = new Map<string, Managed>();
  private readonly byThread = new WeakMap<vscode.CommentThread, string>();
  private readonly excludedRoots = new Set<string>();
  private ctx: RenderContext = { userName: 'Moi' };

  constructor(private readonly log: Log) {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Local Review');
    this.controller.options = {
      prompt: 'Commenter',
      placeHolder: 'Votre commentaire (markdown accepté)…',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => this.commentingRanges(doc),
    };
  }

  /** (Re)discovers roots and re-renders every stored thread. */
  async reload(): Promise<void> {
    for (const m of this.managed.values()) m.thread.dispose();
    this.managed.clear();

    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    await this.roots.init(folders.map((f) => f.uri.fsPath));
    this.ctx = { userName: await this.resolveUserName() };

    for (const root of this.roots.all()) {
      try {
        const { threads, warnings } = await root.store.loadAll();
        warnings.forEach((w) => this.log.warn(`${root.path}: ${w}`));
        threads.forEach((state) => this.render(root, state));
        this.log.info(`${root.path}: ${threads.length} fil(s) chargé(s)`);
      } catch (err) {
        this.log.error(`${root.path}: chargement impossible`, err);
      }
    }
  }

  /** Handler of the "Commenter" button under a new thread's input. */
  async submitNewComment(reply: vscode.CommentReply): Promise<void> {
    const { thread } = reply;
    const text = reply.text.trim();
    if (text === '' || this.byThread.has(thread)) return;

    const root = this.roots.forFile(thread.uri.fsPath);
    if (thread.uri.scheme !== 'file' || !root) {
      void vscode.window.showErrorMessage('Local Review : ce fichier ne fait partie d’aucun dossier du workspace.');
      return;
    }
    if (!thread.range) {
      void vscode.window.showWarningMessage('Local Review : les commentaires de fichier arrivent bientôt (US-15).');
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const anchor: Anchor = {
        path: Roots.anchorPath(root, thread.uri.fsPath),
        source: 'worktree',
        ref: null,
        sha: null,
        ...buildAnchorContext(doc.getText(), toLineRange(thread.range.start, thread.range.end)),
      };
      const state = await root.store.createThread(anchor, { author: 'user', body: text, reviewId: null });
      this.adopt(root, state, thread);
      await this.excludeFromGit(root);
    } catch (err) {
      this.log.error('Échec de l’enregistrement du commentaire', err);
      void vscode.window.showErrorMessage(`Local Review : le commentaire n’a pas pu être enregistré (${String(err)}).`);
    }
  }

  cancelNewThread(reply: vscode.CommentReply | vscode.CommentThread): void {
    const thread = 'thread' in reply ? reply.thread : reply;
    if (!this.byThread.has(thread)) thread.dispose();
  }

  /** Snapshot for tests and diagnostics. */
  listThreads(): { id: string; state: ThreadState; thread: vscode.CommentThread }[] {
    return [...this.managed.entries()].map(([id, m]) => ({ id, state: m.state, thread: m.thread }));
  }

  dispose(): void {
    this.controller.dispose();
  }

  private commentingRanges(doc: vscode.TextDocument): vscode.Range[] {
    if (doc.uri.scheme !== 'file' || !this.roots.isCommentable(doc.uri.fsPath)) return [];
    return [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)];
  }

  private render(root: Root, state: ThreadState): void {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(root.path), ...state.anchor.path.split('/'));
    const range = threadRange(state) ?? new vscode.Range(0, 0, 0, 0);
    const thread = this.controller.createCommentThread(uri, range, []);
    thread.collapsibleState =
      state.status === 'resolved'
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
    this.adopt(root, state, thread);
  }

  private adopt(root: Root, state: ThreadState, thread: vscode.CommentThread): void {
    const range = threadRange(state);
    if (range) thread.range = range;
    applyThreadState(thread, state, this.ctx);
    this.managed.set(state.id, { state, root, thread });
    this.byThread.set(thread, state.id);
  }

  private async excludeFromGit(root: Root): Promise<void> {
    if (!root.isGit || this.excludedRoots.has(root.path)) return;
    if (!vscode.workspace.getConfiguration('localReview').get<boolean>('excludeFromGit', true)) return;
    try {
      if (await ensureExcluded(root.path)) this.log.info(`${root.path}: .local-review/ ajouté à .git/info/exclude`);
      this.excludedRoots.add(root.path);
    } catch (err) {
      this.log.warn(`${root.path}: impossible de mettre à jour .git/info/exclude`, err);
    }
  }

  private async resolveUserName(): Promise<string> {
    const configured = vscode.workspace.getConfiguration('localReview').get<string>('userName', '').trim();
    if (configured) return configured;
    const first = this.roots.all()[0];
    const fromGit = first ? await gitUserName(first.path) : null;
    if (fromGit) return fromGit;
    try {
      return userInfo().username;
    } catch {
      return 'Moi';
    }
  }
}
