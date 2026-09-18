"""Drag gallery items into the order the site shows them in.

Every gallery/g* folder is listed, including ones without a preview.* file
(those never reach the site and are drawn grayed out).  Saving writes
gallery/order.txt, which generate-gallery.py follows, and reorders the
existing gallery-data.js in place so no proxies need re-rendering.

Usage:
    python organize-gallery.py

Drag a row to move it; Ctrl+Up / Ctrl+Down move the selected row; Ctrl+S saves.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk


ROOT = Path(__file__).resolve().parent

# The generator is loaded as a module for its folder rules; keep that import
# from rewriting the __pycache__ files tracked in git.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("generate_gallery", ROOT / "generate-gallery.py")
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)

THUMB_W, THUMB_H = 96, 60
THUMB_CACHE = Path(tempfile.gettempdir()) / "fqqf-gallery-thumbs"
HIDDEN_STEMS = ("preview", "hide")


# ============================================================
# FOLDER SCAN
# ============================================================

def media_named(folder: Path, stem: str) -> Path | None:
    matches = sorted(
        path for path in folder.iterdir()
        if path.is_file() and path.stem.lower() == stem
        and path.suffix.lower() in gen.MEDIA_EXTENSIONS
    )
    return matches[0] if matches else None


def thumb_source(folder: Path, preview: Path | None) -> Path | None:
    """Cheapest file that looks like the card: the proxy thumb, else any cover."""
    proxy = folder / gen.OPT_DIRNAME / "preview-thumb.webp"
    if preview and proxy.is_file():
        return proxy
    for stem in HIDDEN_STEMS:
        found = media_named(folder, stem)
        if found:
            return found
    media = sorted(
        (path for path in folder.iterdir()
         if path.is_file() and path.suffix.lower() in gen.MEDIA_EXTENSIONS),
        key=gen.natural_key,
    )
    return media[0] if media else None


def scan() -> list[dict[str, object]]:
    rows = []
    for folder in gen.ordered_folders():
        preview = media_named(folder, gen.PREVIEW_STEM)
        tags, title, short_description, _ = gen.read_metadata(folder)
        rows.append({
            "name": folder.name,
            "title": title or short_description,
            "tags": " ".join("#" + tag for tag in tags),
            "preview": preview,
            "thumb": thumb_source(folder, preview),
        })
    return rows


# ============================================================
# THUMBNAILS (ffmpeg -> PNG, since Tk cannot read webp/video)
# ============================================================

def render_thumb(source: Path, gray: bool) -> Path | None:
    stat = source.stat()
    key = "{}:{}:{}:{}".format(source, stat.st_mtime_ns, gray, THUMB_W)
    target = THUMB_CACHE / (hashlib.sha1(key.encode("utf-8")).hexdigest()[:16] + ".png")
    if target.is_file() and target.stat().st_size:
        return target
    THUMB_CACHE.mkdir(parents=True, exist_ok=True)
    filters = [
        "scale={}:{}:force_original_aspect_ratio=decrease".format(THUMB_W, THUMB_H),
        "pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black".format(THUMB_W, THUMB_H),
    ]
    if gray:
        filters.append("format=gray")
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
         "-frames:v", "1", "-vf", ",".join(filters), str(target)],
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return target if result.returncode == 0 and target.is_file() else None


# ============================================================
# SAVE
# ============================================================

def folder_of(item: dict[str, object]) -> str:
    parts = Path(str(item.get("preview") or "")).parts
    return parts[1] if len(parts) > 1 else ""


def save_order(names: list[str], rows: list[dict[str, object]]) -> list[str]:
    """Write order.txt and reorder gallery-data.js; return warnings."""
    gen.ORDER_FILE.write_text(
        "# Gallery order, top first. Written by organize-gallery.py.\n"
        + "\n".join(names) + "\n",
        encoding="utf-8",
    )

    warnings = []
    if not gen.OUTPUT.is_file():
        return ["gallery-data.js does not exist yet - run generate-gallery.py."]

    text = gen.OUTPUT.read_text(encoding="utf-8")
    start = text.index("=") + 1
    items = json.loads(text[start:].strip().rstrip(";"))
    rank = {name: index for index, name in enumerate(names)}
    items.sort(key=lambda item: rank.get(folder_of(item), len(rank)))
    gen.write_data(items)

    in_data = {folder_of(item) for item in items}
    missing = [row["name"] for row in rows if row["preview"] and row["name"] not in in_data]
    stale = sorted(in_data - {row["name"] for row in rows if row["preview"]})
    if missing:
        warnings.append("Not in gallery-data.js yet: " + ", ".join(missing))
    if stale:
        warnings.append("In gallery-data.js but no preview any more: " + ", ".join(stale))
    if warnings:
        warnings.append("Run generate-gallery.py to bring the data up to date.")
    return warnings


# ============================================================
# GUI
# ============================================================

class Organizer:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.dirty = False
        self.dragging = None
        self.images: dict[str, tk.PhotoImage] = {}
        self.thumb_queue: queue.Queue = queue.Queue()
        self.rows: list[dict[str, object]] = []

        root.title("Gallery order")
        root.geometry("760x640")
        root.minsize(480, 300)

        style = ttk.Style(root)
        style.configure("Treeview", rowheight=THUMB_H + 8)

        bar = ttk.Frame(root, padding=(8, 8, 8, 4))
        bar.pack(fill="x")
        ttk.Button(bar, text="Save", command=self.save).pack(side="left")
        ttk.Button(bar, text="Reload", command=self.reload).pack(side="left", padx=(6, 0))
        self.status = ttk.Label(bar, foreground="#666")
        self.status.pack(side="left", padx=12)

        body = ttk.Frame(root, padding=(8, 0, 8, 8))
        body.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(body, columns=("title", "tags", "preview"), selectmode="browse")
        self.tree.heading("#0", text="Folder", anchor="w")
        self.tree.heading("title", text="Title", anchor="w")
        self.tree.heading("tags", text="Tags", anchor="w")
        self.tree.heading("preview", text="Preview", anchor="w")
        self.tree.column("#0", width=190, stretch=False)
        self.tree.column("title", width=260)
        self.tree.column("tags", width=130, stretch=False)
        self.tree.column("preview", width=150, stretch=False)
        self.tree.tag_configure("hidden", foreground="#a0a0a0")
        scroll = ttk.Scrollbar(body, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        self.tree.bind("<ButtonPress-1>", self.on_press)
        self.tree.bind("<B1-Motion>", self.on_drag)
        self.tree.bind("<ButtonRelease-1>", self.on_release)
        root.bind("<Control-Up>", lambda event: self.nudge(-1))
        root.bind("<Control-Down>", lambda event: self.nudge(1))
        root.bind("<Control-s>", lambda event: self.save())
        root.protocol("WM_DELETE_WINDOW", self.close)

        self.reload()
        self.root.after(100, self.poll_thumbs)

    # ---- data ----

    def reload(self) -> None:
        if self.dirty and not messagebox.askyesno("Reload", "Discard unsaved changes?"):
            return
        self.rows = scan()
        self.tree.delete(*self.tree.get_children())
        for row in self.rows:
            hidden = row["preview"] is None
            self.tree.insert(
                "", "end", iid=row["name"], text="  " + row["name"],
                image=self.images.get(row["name"], ""),
                values=(row["title"], row["tags"],
                        "(no preview)" if hidden else row["preview"].name),
                tags=("hidden",) if hidden else (),
            )
        self.set_dirty(False)
        self.load_thumbs()

    def load_thumbs(self) -> None:
        if not shutil.which("ffmpeg"):
            self.status.configure(text="ffmpeg not on PATH - no thumbnails")
            return
        jobs = [(row["name"], row["thumb"], row["preview"] is None)
                for row in self.rows if row["thumb"]]

        def work() -> None:
            for name, source, gray in jobs:
                try:
                    self.thumb_queue.put((name, render_thumb(source, gray)))
                except OSError:
                    pass

        threading.Thread(target=work, daemon=True).start()

    def poll_thumbs(self) -> None:
        while not self.thumb_queue.empty():
            name, path = self.thumb_queue.get_nowait()
            if path and self.tree.exists(name):
                try:
                    self.images[name] = tk.PhotoImage(file=str(path))
                    self.tree.item(name, image=self.images[name])
                except tk.TclError:
                    pass
        self.root.after(100, self.poll_thumbs)

    def save(self) -> None:
        names = list(self.tree.get_children())
        try:
            warnings = save_order(names, self.rows)
        except (OSError, ValueError) as error:
            messagebox.showerror("Save failed", str(error))
            return
        self.set_dirty(False)
        if warnings:
            messagebox.showwarning("Saved with warnings", "\n\n".join(warnings))

    def set_dirty(self, dirty: bool) -> None:
        self.dirty = dirty
        self.root.title("Gallery order" + (" *" if dirty else ""))
        if dirty:
            self.status.configure(text="unsaved changes")
        elif self.rows:
            self.status.configure(text="drag rows to reorder, then Save")

    def close(self) -> None:
        if self.dirty:
            answer = messagebox.askyesnocancel("Unsaved changes", "Save the new order before closing?")
            if answer is None:
                return
            if answer:
                self.save()
                if self.dirty:
                    return
        self.root.destroy()

    # ---- moving rows ----

    def move(self, iid: str, index: int) -> None:
        if self.tree.index(iid) != index:
            self.tree.move(iid, "", index)
            self.set_dirty(True)

    def nudge(self, step: int) -> None:
        selection = self.tree.selection()
        if selection:
            iid = selection[0]
            index = max(0, min(len(self.tree.get_children()) - 1, self.tree.index(iid) + step))
            self.move(iid, index)
            self.tree.see(iid)

    def on_press(self, event: tk.Event) -> None:
        self.dragging = self.tree.identify_row(event.y) or None
        if self.dragging:
            self.tree.configure(cursor="fleur")

    def on_drag(self, event: tk.Event) -> None:
        if not self.dragging:
            return
        height = self.tree.winfo_height()
        if event.y < 24:
            self.tree.yview_scroll(-1, "units")
        elif event.y > height - 24:
            self.tree.yview_scroll(1, "units")
        target = self.tree.identify_row(max(0, min(height - 1, event.y)))
        if target and target != self.dragging:
            self.move(self.dragging, self.tree.index(target))
            self.tree.selection_set(self.dragging)

    def on_release(self, event: tk.Event) -> None:
        self.dragging = None
        self.tree.configure(cursor="")


def main() -> None:
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass
    root = tk.Tk()
    Organizer(root)
    root.mainloop()


if __name__ == "__main__":
    main()
