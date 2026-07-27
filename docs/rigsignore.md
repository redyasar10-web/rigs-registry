# `.rigsignore`

`rigs pack` already refuses to publish credentials, prompt history and machine
state. `.rigsignore` is for the other category: things that are perfectly safe
but simply yours — a client-specific skill, a half-finished agent, a private
prompt you would rather not hand to strangers.

Put the file at the root of the folder you are packing, usually `~/.claude`.

```
~/.claude/.rigsignore
```

The `.rigsignore` file is never published itself.

## Format

One pattern per line.

- Blank lines are ignored.
- Lines starting `#` are comments.
- Surrounding whitespace is stripped.
- A trailing `/` is stripped, so `skills/private/` and `skills/private` are the
  same pattern.

```
# my own stuff, not dangerous, just mine
skills/client-acme/
agents/half-finished.md
*.secret
scratch.md
```

## How a pattern matches

A pattern without `*` matches when any of these hold, against the path relative
to the packed root:

| Pattern | Matches |
|---|---|
| `skills/private` | the path `skills/private` and everything under it |
| `agents/notes.md` | that exact file |
| `notes.md` | any file named `notes.md`, in any directory |

A bare filename is a basename match, so `notes.md` excludes
`skills/a/notes.md` and `agents/b/notes.md` alike. If you mean one specific
file, give its full relative path.

Prefix matching is on whole path segments. `skills/foo` does **not** match
`skills/foobar`.

A pattern containing `*` becomes a glob, and `*` matches within a single path
segment — it never crosses `/`. It is tried against each segment of the path
and against the whole path.

| Pattern | Matches | Does not match |
|---|---|---|
| `*.secret` | `skills/a/creds.secret` | `skills/a/creds.md` |
| `draft-*` | `commands/draft-ship.md` | `commands/ship-draft.md` |

## Two things it deliberately cannot do

**It cannot re-include anything.** There is no `!` negation. `.rigsignore` only
ever subtracts. Listing `settings.local.json` in it changes nothing — that path
is on the hard-deny list and stays excluded either way. The deny list is
checked first, so it always wins.

**`skills/*` is not a way to exclude everything under `skills/`.** Because `*`
stops at the separator, `skills/*` matches `skills/a` but not
`skills/a/SKILL.md` — and only files are matched, so nothing is actually
excluded. To hold back a whole directory, name it:

```
skills/client-acme      # correct — the directory and everything under it
skills/*                # excludes nothing
```

## Checking your work

`pack` prints a line counting what it held back, with your `.rigsignore`
exclusions tallied separately from the hard-denied ones:

```
  filtered out  <n> sensitive, <n> via .rigsignore
```

If that count is not what you expected, the pattern did not match what you
thought. Nothing was published at that point — the destination is only written
after the scan passes — so fix the pattern and re-run.
