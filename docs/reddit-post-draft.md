# Suggested Reddit Post

Title ideas:

- I made a small ComfyUI node for browsing wildcards and previewing the resolved prompt
- ComfyUI Wildcard Organizer: search, build, group, and resolve wildcard prompts
- Sharing a lightweight wildcard organizer node for ComfyUI

Post:

I made a small ComfyUI custom node called **Wildcard Organizer**.

It is meant for people who use a lot of `__wildcard__` files and want a cleaner way to search, preview, and compose them without constantly jumping between folders and the text encoder.

What it does:

- searches `.txt`, `.yaml`, and `.yml` wildcard folders recursively
- previews wildcard file contents before adding them
- builds prompt rows directly inside the node
- supports literal text rows
- groups selected rows into choice expressions like `{red | blue | black}`
- shows the raw prompt and the resolved prompt side by side
- lets you reroll with a deterministic seed

The feature I personally wanted most was the resolved prompt preview. The node can show the exact sampled string that gets sent downstream, which makes debugging wildcard-heavy prompts a lot less mysterious.

GitHub:

https://github.com/lokitsar/ComfyUI-WildcardOrganizer

I would love feedback, especially from people with large wildcard libraries or weird folder structures.

Notes:

- It is intentionally lightweight.
- It works with normal ComfyUI wildcard tokens.
- The path normalization is compatible with the common Impact Pack wildcard convention too.
- It does not phone home or install dependencies at runtime.
