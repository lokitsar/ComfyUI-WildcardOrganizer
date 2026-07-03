# ComfyUI Wildcard Organizer

![ComfyUI Wildcard Organizer cover](docs/images/cover.png)

A small ComfyUI custom node for browsing wildcard folders, composing prompts, and seeing the exact resolved prompt text before it goes into your text encoder.

## Features

- Search `.txt`, `.yaml`, and `.yml` wildcard files recursively.
- Search by wildcard key, filename, or optionally file contents.
- Preview wildcard file contents before adding a token.
- Star frequently used wildcards and custom text tags as browser-local favorites.
- Save and load full prompt recipes.
- Build prompts with draggable wildcard rows and literal text rows.
- Group rows into ComfyUI choice expressions like `{red | blue | black}`.
- Resolve `__wildcard__` tokens and `{choice | groups}` with a deterministic seed.
- Toggle between sending resolved text or raw wildcard expressions downstream.

## Screenshots

![Search wildcard folders](docs/images/search-results.png)

![Group rows into choices](docs/images/choice-group.png)

![Resolved prompt preview](docs/images/resolved-prompt.png)

## Install

Clone this repository into your ComfyUI custom nodes folder:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/lokitsar/ComfyUI-WildcardOrganizer.git
```

Or download the repository as a zip and extract it so the folder is:

```text
ComfyUI/custom_nodes/ComfyUI-WildcardOrganizer
```

Then restart ComfyUI.

## Build Your First Prompt

1. Add `utils/wildcards -> Wildcard Organizer` to your workflow.
2. Set `wildcard_folder` to the folder that contains your wildcard files.
3. Type your base prompt in `Manual Prompt`, then choose `Prepend` or `Append` to place it before or after the builder rows.
4. Search for a wildcard, such as `hair`, `outfit`, or `background`.
5. Click a search result to preview what is inside it.
6. Press `Add` to put that wildcard into the builder.
7. Use `Text part` and `Add Text` for small reusable tags like `eyes`, `smiling`, or `cinematic lighting`.
8. Select two or more builder rows and press `Group Choice` when you want one random option from a group.
9. Look at `Wildcard Preview / Raw Prompt` to see the wildcard expression.
10. Look at `Resolved Prompt` to see the actual text that will be sent to the next node.
11. Connect the `prompt` output to your text encoder.

The first search builds an in-memory index for the selected wildcard folder. Later searches reuse that index instead of walking the folder again. Press `Refresh Index` after editing wildcard files.

Use `Exclude terms` to filter unwanted filenames, keys, or content. Separate terms with commas, semicolons, or new lines.

## Favorites

Use favorites for small pieces you reuse often.

1. Select a wildcard search result and press `Star`.
2. Or select a builder row, such as a custom text tag, and press `Star`.
3. Press `Favorites` to show saved wildcards and text tags.
4. Press `Favorites` again to return to normal search results.

Favorites are saved in your browser local storage. They do not edit your wildcard files.

## Prompt Recipes

Use recipes for whole prompt setups you want to reuse later.

1. Build a prompt with manual text, wildcard rows, text rows, and choice groups.
2. Type a recipe name, such as `Pony portrait base`.
3. Press `Save Recipe`.
4. Pick the recipe from the dropdown later.
5. Press `Load` to restore the manual prompt, manual prompt position, builder rows, separator, seed, and resolved-output setting.

Recipes are also saved in browser local storage.

## Prompt Builder

The builder can compose the final prompt directly:

```text
masterpiece, high quality, score_9, __body_eye_color__, eyes, __cc_hairstyle_set__, __body-short__, __setting-scifi__
```

The raw prompt stays visible, while the resolved prompt shows the sampled output:

```text
masterpiece, high quality, score_9, ((multicolored eyes, two-tone eyes):0.9), eyes, Voluminous apricot waves hairstyle, pygmy, A Pilot flying an advanced spaceship through an asteroid field
```

Use `send resolved text` to choose whether the output sends the resolved prompt or the raw wildcard expression. Use `Reroll` or edit the seed to pick a different deterministic wildcard outcome.

## Wildcard Naming

The node emits normal ComfyUI wildcard tokens such as:

```text
__hair-color__
__people/hair-color__
```

For `.txt` files, wildcard keys come from the file path relative to the wildcard folder, with the extension removed:

- Backslashes are converted to `/`.
- Spaces are converted to `-`.
- Keys are lowercased.

For `.yaml` and `.yml` files, entries are expanded from YAML keys, including nested keys.

This path behavior is compatible with the common Impact Pack wildcard convention, but the node is intended for ordinary ComfyUI wildcard folders too.

## Output

The node has one output:

- `prompt`: the composed prompt string, either resolved or raw depending on the `send resolved text` checkbox.

## License

MIT
