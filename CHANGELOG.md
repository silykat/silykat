# Changelog

## [0.11.0](https://github.com/silykat/silykat/compare/v0.10.0...v0.11.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* rename your .local-review folders to .silykat (and ~/.local-review to ~/.silykat), run slk review <command> instead of lr <command>, and install the silykat extension and the silykat@silykat plugin in place of the old ones

### Features

* rename the product to silykat, with the slk command line and its commands grouped by module ([c638277](https://github.com/silykat/silykat/commit/c638277f402d085c31255b57604f10a6139d56a4))
* **vscode-extension:** install silykat from the VS Code Marketplace or Open VSX ([c638277](https://github.com/silykat/silykat/commit/c638277f402d085c31255b57604f10a6139d56a4))

## [0.10.0](https://github.com/lbenamer/local-review/compare/v0.9.0...v0.10.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* archive, export and clean up review threads, from VS Code and with lr
* **claude-code:** the comment store format goes to version 2; update Local Review everywhere you use it, as an older version shows archived threads read-only

### Features

* archive, export and clean up review threads, from VS Code and with lr ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))
* check whether the last retro's changes helped, and get reminded when a retro is due ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))
* choose whether to keep deleted threads with the keep history setting ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))
* **claude-code:** choose the sources of a retro: review threads, agent sessions and an audit of the setup ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))
* **claude-code:** leave out of a retro the sessions too long to analyse, and write session reports longest first ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))
* **claude-code:** read the agent's sessions of the project in retros, with a report on each session or through /insights ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))
* **claude-code:** run a retro with your agent to decide what to keep, remove or improve in its setup, and let it apply what you accept ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))
* **cli:** read the whole comment history of a project, worktrees included, with lr history ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))
* keep every thread, with why it was deleted, and link each agent reply to its conversation ([3637cd5](https://github.com/lbenamer/local-review/commit/3637cd5d3fc99bf77a874f10281eb3c6862b49a8))

## [0.9.0](https://github.com/lbenamer/local-review/compare/v0.8.2...v0.9.0) (2026-09-30)


### Features

* say to update Local Review when a newer version wrote the comments ([97b907c](https://github.com/lbenamer/local-review/commit/97b907c9cee368db858ea126f1e47d4593112cc1))


### Bug Fixes

* **claude-code:** read the plugin version when the channel starts ([97b907c](https://github.com/lbenamer/local-review/commit/97b907c9cee368db858ea126f1e47d4593112cc1))
* deliver a comment deleted right away, and leave release-please files out of prettier ([#38](https://github.com/lbenamer/local-review/issues/38)) ([53491fb](https://github.com/lbenamer/local-review/commit/53491fb4fadc07d15eb894fc941b62b01be04b52))
* follow a store created again, and keep type packages out of dependabot ([#35](https://github.com/lbenamer/local-review/issues/35)) ([bd7bfc1](https://github.com/lbenamer/local-review/commit/bd7bfc1018c3f191f48df88fa57fa4d9475cbe32))
* make the whole suite pass on linux, and fix what it found ([#31](https://github.com/lbenamer/local-review/issues/31)) ([839eae7](https://github.com/lbenamer/local-review/commit/839eae7a618dd0ec2573d2c01f8a4eda9a2f8f00))
* one review per folder for files not tracked by git ([#28](https://github.com/lbenamer/local-review/issues/28)) ([93c2757](https://github.com/lbenamer/local-review/commit/93c2757018c664170899a7126c2d40ad7c28697e))
* **vscode-extension:** keep review buttons while a comment input has focus ([#26](https://github.com/lbenamer/local-review/issues/26)) ([09a2edf](https://github.com/lbenamer/local-review/commit/09a2edfdd58c335411232d01b49a4ab0d02d598a))
