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

Otherwise, run `lr list`. It prints every thread where the user spoke last, with:

- the file and the **current** lines of the commented code (threads follow the code as the file changes);
- the conversation so far;
- the review summary, when the comments come from a submitted review. Read it first: it gives the overall intent.

## 2. Handle each thread, in file order

Read the current code around the thread's lines before deciding. Then do exactly one of these:

- **Apply the request.** Change the code, then reply briefly with what you did, marking the thread addressed:
  ```bash
  lr reply <thread-id> --agent Claude --status addressed --body - <<'EOF'
  Done: `find` now throws `NotFoundError` instead of returning null.
  EOF
  ```
- **Ask for a precision**, when the request is ambiguous or several options are reasonable. Do **not** change the code; ask one precise question:
  ```bash
  lr reply <thread-id> --agent Claude --status needs-info --body - <<'EOF'
  Should it throw `NotFoundError` or return a `Result`? Other callers of `find` expect null today.
  EOF
  ```
- **Disagree**, when you think the request is not a good idea. Explain why in a few sentences, also with `--status needs-info`, and do not change the code.

Always pass the body on stdin with `--body -` and a quoted heredoc as above, so that Markdown and quotes need no escaping. Reply in the language of the user's comment. Keep replies short, and quote code when it helps.

## 3. Special cases

- **"About the version … , not the working tree"**: the comment was made on an older or staged version of the file (a side of a diff). Apply it to the current code if it still applies, and say so in your reply.
- **"(whole file)"**: the comment is about the file as a whole.
- **"⚠️ Outdated"**: the commented code is no longer in the file. Do not guess where it went: reply that you cannot find it (with `--status needs-info`), unless the conversation makes it obvious.
- A thread where you already asked a question and the user has not answered yet is not listed: leave it alone.
- You never resolve threads: only the user does.

## 4. Finish

Run `lr status` to check that nothing is left, then give the user a short summary: threads addressed, questions asked, files changed.
