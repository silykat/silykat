---
name: review
description: Address the user's Local Review comments, i.e. the code review threads they left in VS Code with the Local Review extension. Read the threads with `lr`, change the code, and reply in each thread. Use when the user asks you to handle, address, fix or answer their review comments, says their review is ready, or when a Local Review channel message says they published comments.
allowed-tools: Bash(lr:*)
---

# Address the Local Review comments

The user reviews your code in VS Code and leaves comments in threads, like on a GitHub pull request. You answer in those threads with the `lr` command (it is on your PATH). Each reply shows up live in their editor.

## 1. See what is waiting

**Started by a Local Review channel message** (`<channel source="…local-review…" store="<folder>" threads="<ids>">`): the user just published comments in that folder, and expects you to handle them without being asked. Add `--root <folder>` to every `lr` command below, and list only the threads of the message (`lr list --root <folder> --thread <id> --thread <id>…`): the other threads waiting in that folder may be for another session. When you were busy with another task, finish or pause it at a sensible point first, then handle the comments, then go back to it.

Run `lr status`. If no thread waits for you, tell the user and stop.

If `lr` says there is **no Local Review store** here but lists **stores below this folder** (you were started in a parent folder of several repositories or worktrees), handle each listed store in turn by adding `--root <dir>` to every `lr` command (`lr status --root <dir>`, `lr list --root <dir>`, `lr reply <thread-id> --root <dir> …`). If it lists none, tell the user that nothing has been commented in this folder yet.

Otherwise, run `lr list`. It prints the threads where the user spoke last, **on the branches (or paths) this session is subscribed to** (see section 4; `--any-topic` lists them all, e.g. when the user asks you to look at another branch), with:

- the file and the **current** lines of the commented code (threads follow the code as the file changes);
- the conversation so far;
- the review summary, when the comments come from a submitted review. Read it first: it gives the overall intent.

## 2. Handle each thread, in file order

Read the current code around the thread's lines before deciding. Then do exactly one of these:

- **Apply the request.** Change the code, then reply briefly with what you did, marking the thread addressed:
  ```bash
  lr reply <thread-id> --agent Claude --rev <version> --status addressed --body - <<'EOF'
  Done: `find` now throws `NotFoundError` instead of returning null.
  EOF
  ```
- **Ask for a precision**, when the request is ambiguous or several options are reasonable. Do **not** change the code; ask one precise question:
  ```bash
  lr reply <thread-id> --agent Claude --rev <version> --status needs-info --body - <<'EOF'
  Should it throw `NotFoundError` or return a `Result`? Other callers of `find` expect null today.
  EOF
  ```
- **Disagree**, when you think the request is not a good idea. Explain why in a few sentences, also with `--status needs-info`, and do not change the code.

Always pass `--rev` with the **version** `lr list` showed for the thread ("Version: …"): the user may edit or delete comments while you work.

- **Exit code 3**: the user changed the thread since you read it. `lr` prints it as it is now: adapt your work to the new request (e.g. a rename to another name), then reply again with the new version.
- **Exit code 2**, "deleted by the user": stop working on that thread and go on with the others. If you already changed code for it, ask the user in the chat whether to undo those changes; never undo them on your own.

Always pass the body on stdin with `--body -` and a quoted heredoc as above, so that Markdown and quotes need no escaping. Reply in the language of the user's comment. Keep replies short, and quote code when it helps.

## 3. Special cases

- **"About the version … , not the working tree"**: the comment was made on an older or staged version of the file (a side of a diff). Apply it to the current code if it still applies, and say so in your reply.
- **"(whole file)"**: the comment is about the file as a whole.
- **"⚠️ Outdated"**: the commented code is no longer in the file. Do not guess where it went: reply that you cannot find it (with `--status needs-info`), unless the conversation makes it obvious.
- A thread where you already asked a question and the user has not answered yet is not listed: leave it alone.
- You never resolve threads: only the user does.

## 4. Subscriptions: which comments come to you

Local Review publishes each comment to the sessions **subscribed** to its branch (or, outside git, its file or folder). This session is subscribed automatically when it was started in a git worktree, and when it modifies a file (you are then told so: pass it on to the user). The user may also ask you:

- "subscribe to this branch / this repo / this folder" → `lr subscribe [<folder or file>]` (`--path` for a folder or file rather than its branch);
- "unsubscribe" → `lr unsubscribe [<folder or file>]`, or `lr unsubscribe --all`;
- "what are you subscribed to?" → `lr subscriptions`.

Whenever a subscription changes, say so in your reply, in one short sentence. Being subscribed does not mean doing everything: a comment may also go to other sessions (e.g. a reviewer); do what fits your role in this session.

## 5. Finish

Run `lr status` to check that nothing is left, then give the user a short summary: threads addressed, questions asked, files changed.
