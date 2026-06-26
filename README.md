# ComfyUI Wildcard Organizer

A small ComfyUI custom node for browsing Impact Pack-style wildcard folders.

The node scans `.txt`, `.yaml`, and `.yml` wildcard files recursively, lets you search by file name/key, optionally searches file contents, previews the selected file or YAML entry, and copies the wildcard token in the format Impact Pack expects, such as:

```text
__hair-color__
__people/hair-color__
```

## Install

Copy this folder into:

```text
ComfyUI/custom_nodes/ComfyUI-WildcardOrganizer
```

Then restart ComfyUI.

## Use

1. Add `utils/wildcards -> Wildcard Organizer`.
2. Set `wildcard_folder` to the folder that contains your wildcard files.
3. Type a term in the organizer search box.
4. Enable `Search contents` if you want the search to inspect file text too.
5. Press `Search`, click a result to preview it, then press `Copy Token`.

The copied value is the prompt token you can paste into a text encoder.

The first search builds an in-memory index for the selected wildcard folder. Later searches reuse that index instead of walking the folder again. Press `Refresh Index` after editing wildcard files.

Use `Exclude terms` in the organizer to filter out unwanted filenames/keys/content. Separate terms with commas, semicolons, or new lines.

Favorites:

- Select a wildcard and press `Star` to favorite or unfavorite it.
- Press `Favorites` to show only favorites.
- Favorites are saved in browser local storage and do not modify wildcard files.

## Prompt Builder

The same node can compose the final prompt directly:

1. Search for a wildcard and click a result.
2. Press `Add` to put it into the builder.
3. Drag builder rows to reorder them.
4. Select two or more wildcard rows and press `Group Choice` to make a ComfyUI choice expression like `{__holiday__ | __setting__ | __holiday_theme__}`.
5. Use `Ungroup` to split a selected choice group back into separate rows.
6. Use `Text part` plus `Add Text` for literal phrases such as `wearing` or `in`.
7. Click builder rows to highlight them. Use `Remove Selected` to remove highlighted rows.
8. Double-click a builder row to remove it quickly.
9. Connect the `prompt` output to a text encoder.

The organizer is embedded directly in the node as a custom ComfyUI DOM widget. Resize the node wider if you want more room for search results, builder rows, and preview text.

The node has one output:

- `prompt`: the final composed prompt string.

The builder preserves wildcard tokens and ComfyUI choice groups. It does not expand `__wildcard__` tokens itself.

Example builder output using an empty joiner and text rows like `, wearing ` and `, in `:

```text
{__hair-color__ | __eye-color__}, wearing {__shirt__ | __jacket__ | __dress__}, in __location__
```

## Impact Pack Compatibility

This follows the wildcard naming behavior used by `ltdrdata/ComfyUI-Impact-Pack`:

- `.txt` wildcard keys come from the file path relative to the wildcard folder, with the extension removed.
- Backslashes are converted to `/`.
- Spaces are converted to `-`.
- Keys are lowercased.
- `.yaml` and `.yml` files are expanded from their YAML keys, including nested keys.

For example:

```text
wildcards/hair color.txt          -> __hair-color__
wildcards/people/hair color.txt   -> __people/hair-color__
```
