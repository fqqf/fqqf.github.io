from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import subprocess
import sys
import os
import time
import json
import threading


# ============================================================
# НАСТРОЙКИ
# ============================================================

ROOT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()

# Сколько видео кодировать одновременно.
#
# 2 — рекомендуется.
# 3 — для мощного CPU.
# 4+ обычно уже не даёт пропорционального ускорения.
WORKERS = 2

# VP9 CRF.
#
# Будет дополнительно автоматически корректироваться
# в зависимости от исходного видео.
BASE_CRF = 31

# Скорость кодирования VP9.
#
# 0 = самое медленное / максимальная эффективность
# 4 = хороший баланс
# 5 = быстрее
# 6-8 = очень быстро, но хуже эффективность сжатия
CPU_USED = 4

AUDIO_BITRATE = "128k"

# Обновление progress bar.
PROGRESS_UPDATE = 0.2


# ============================================================
# ГЛОБАЛЬНОЕ СОСТОЯНИЕ ПРОГРЕССА
# ============================================================

progress_lock = threading.Lock()

progress = {}


# ============================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ============================================================

def format_size(size):
    units = ["B", "KB", "MB", "GB", "TB"]

    value = float(size)

    for unit in units:
        if value < 1024:
            return f"{value:.2f} {unit}"

        value /= 1024

    return f"{value:.2f} PB"


def format_time(seconds):
    seconds = int(seconds)

    h, remainder = divmod(seconds, 3600)
    m, s = divmod(remainder, 60)

    if h:
        return f"{h}ч {m}м {s}с"

    if m:
        return f"{m}м {s}с"

    return f"{s}с"


def format_duration(seconds):
    seconds = float(seconds)

    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)

    return f"{h:02d}:{m:02d}:{s:02d}"


def print_progress():

    with progress_lock:

        if not progress:
            return

        lines = []

        for index, data in progress.items():

            percent = data["percent"]
            width = 30

            filled = int(width * percent / 100)
            bar = "█" * filled + "░" * (width - filled)

            name = data["name"]

            # Ограничиваем длину имени,
            # чтобы не разъезжался терминал.
            if len(name) > 45:
                name = "..." + name[-42:]

            lines.append(
                f"{name:<45} "
                f"[{bar}] "
                f"{percent:6.2f}%"
            )

        # Перерисовываем строки.
        sys.stdout.write(
            "\033[{}A".format(len(lines))
        )

        for line in lines:
            sys.stdout.write("\r" + line + "\n")

        sys.stdout.flush()


def set_progress(index, name, percent):

    with progress_lock:

        progress[index] = {
            "name": name,
            "percent": max(0, min(100, percent)),
        }


# ============================================================
# FFPROBE
# ============================================================

def get_video_info(path):

    command = [
        "ffprobe",
        "-v", "error",

        "-select_streams", "v:0",

        "-show_entries",
        "stream="
        "width,"
        "height,"
        "r_frame_rate,"
        "avg_frame_rate,"
        "pix_fmt,"
        "color_space,"
        "color_transfer,"
        "color_primaries,"
        "bits_per_raw_sample,"
        "bit_rate",

        "-show_entries",
        "format=duration,bit_rate",

        "-of", "json",

        str(path),
    ]

    try:

        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    except FileNotFoundError:
        raise RuntimeError(
            "ffprobe не найден. Он должен идти вместе с FFmpeg."
        )

    if result.returncode != 0:
        raise RuntimeError(
            "ffprobe error: " + result.stderr.strip()
        )

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise RuntimeError("Не удалось разобрать вывод ffprobe.")

    streams = data.get("streams", [])

    if not streams:
        raise RuntimeError("Видео-поток не найден.")

    stream = streams[0]
    fmt = data.get("format", {})

    duration = float(fmt.get("duration") or 0)

    return {
        "width": stream.get("width"),
        "height": stream.get("height"),
        "pix_fmt": stream.get("pix_fmt"),
        "color_space": stream.get("color_space"),
        "color_transfer": stream.get("color_transfer"),
        "color_primaries": stream.get("color_primaries"),
        "bits": stream.get("bits_per_raw_sample"),
        "bitrate": stream.get("bit_rate") or fmt.get("bit_rate"),
        "duration": duration,
    }


# ============================================================
# ВЫБОР CRF
# ============================================================

def choose_crf(info):

    """
    Выбирает CRF в зависимости от характеристик исходника.

    Это НЕ попытка угадать визуальное качество.
    CRF — параметр качества VP9, а не копия исходного bitrate.

    Чем выше исходное разрешение/сложнее видео,
    тем более консервативное значение используем.
    """

    width = info.get("width") or 0
    height = info.get("height") or 0

    pixels = width * height

    crf = BASE_CRF

    # 4K+
    if pixels >= 3840 * 2160:
        crf -= 2

    # 1440p
    elif pixels >= 2560 * 1440:
        crf -= 1

    # HDR / 10-bit
    pix_fmt = info.get("pix_fmt") or ""

    if "10" in pix_fmt or "12" in pix_fmt:
        crf -= 1

    # Не выходим за разумные границы.
    crf = max(24, min(34, crf))

    return crf


# ============================================================
# КОНВЕРТАЦИЯ ОДНОГО ФАЙЛА
# ============================================================

def convert_one(index, mp4_path):

    start_time = time.time()

    webm_path = mp4_path.with_suffix(".webm")

    temp_path = mp4_path.with_name(
        f"{mp4_path.stem}.tmp_{os.getpid()}_{index}.webm"
    )

    set_progress(index, mp4_path.name, 0)

    try:

        original_size = mp4_path.stat().st_size

        # ----------------------------------------------------
        # Определяем характеристики исходника
        # ----------------------------------------------------

        info = get_video_info(mp4_path)

        duration = info["duration"]

        crf = choose_crf(info)

        # ----------------------------------------------------
        # FFmpeg
        # ----------------------------------------------------

        command = [
            "ffmpeg",

            "-hide_banner",

            # Показываем прогресс через stderr.
            "-progress", "pipe:2",

            "-nostats",

            "-i", str(mp4_path),

            # ------------------------------------------------
            # VIDEO
            # ------------------------------------------------

            "-c:v", "libvpx-vp9",

            # Constant Quality.
            "-crf", str(crf),
            "-b:v", "0",

            # Многопоточность VP9.
            "-row-mt", "1",
            "-threads", "0",

            # Скорость.
            "-cpu-used", str(CPU_USED),

            # ------------------------------------------------
            # AUDIO
            # ------------------------------------------------

            "-c:a", "libopus",
            "-b:a", AUDIO_BITRATE,

            # ------------------------------------------------
            # COLOR / PIXEL FORMAT
            # ------------------------------------------------

            # Стараемся сохранить исходную глубину.
            #
            # libvpx-vp9 поддерживает 8/10/12-bit.
            #
            # Если исходник 10-bit — используем yuva420p10le,
            # иначе оставляем обычный yuv420p.
            "-pix_fmt",
            (
                "yuv420p10le"
                if "10" in (info.get("pix_fmt") or "")
                else "yuv420p"
            ),

            # Удаляем metadata.
            "-map_metadata", "-1",

            "-y",
            str(temp_path),
        ]

        # ----------------------------------------------------
        # Запускаем FFmpeg
        # ----------------------------------------------------

        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

        error_lines = []

        # FFmpeg пишет:
        #
        # out_time_us=12345678
        #
        # Используем это для progress bar.

        while True:

            line = process.stderr.readline()

            if not line:
                if process.poll() is not None:
                    break

                continue

            line = line.strip()

            if line.startswith("out_time_us="):

                try:
                    out_time_us = int(
                        line.split("=", 1)[1]
                    )

                    current_time = out_time_us / 1_000_000

                    if duration > 0:

                        percent = (
                            current_time / duration * 100
                        )

                        set_progress(
                            index,
                            mp4_path.name,
                            percent,
                        )

                        print_progress()

                except ValueError:
                    pass

            elif line and not line.startswith(("frame=", "fps=", "stream_")):
                error_lines.append(line)

        return_code = process.wait()

        # ----------------------------------------------------
        # FFmpeg error
        # ----------------------------------------------------

        if return_code != 0:

            if temp_path.exists():
                try:
                    temp_path.unlink()
                except OSError:
                    pass

            error_text = "\n".join(error_lines)

            if len(error_text) > 1500:
                error_text = error_text[-1500:]

            return {
                "status": "error",
                "path": mp4_path,
                "reason": error_text or "FFmpeg завершился с ошибкой",
                "time": time.time() - start_time,
            }

        # ----------------------------------------------------
        # Проверяем результат
        # ----------------------------------------------------

        if not temp_path.exists():

            return {
                "status": "error",
                "path": mp4_path,
                "reason": "FFmpeg не создал WebM",
                "time": time.time() - start_time,
            }

        new_size = temp_path.stat().st_size

        set_progress(index, mp4_path.name, 100)
        print_progress()

        # ----------------------------------------------------
        # WebM не меньше MP4
        # ----------------------------------------------------

        if new_size >= original_size:

            try:
                temp_path.unlink()
            except OSError:
                pass

            return {
                "status": "skipped",
                "path": mp4_path,
                "original_size": original_size,
                "new_size": new_size,
                "crf": crf,
                "time": time.time() - start_time,
            }

        # ----------------------------------------------------
        # WebM меньше
        # ----------------------------------------------------

        saving = original_size - new_size

        percent = (
            saving / original_size * 100
            if original_size
            else 0
        )

        # Старый WebM удаляем только теперь.
        if webm_path.exists():

            try:
                webm_path.unlink()
            except OSError as e:

                temp_path.unlink(missing_ok=True)

                return {
                    "status": "error",
                    "path": mp4_path,
                    "reason": (
                        "Не удалось удалить существующий WebM: "
                        f"{e}"
                    ),
                    "time": time.time() - start_time,
                }

        # Перемещаем готовый файл.
        temp_path.replace(webm_path)

        # И только после этого удаляем MP4.
        try:
            mp4_path.unlink()
        except OSError as e:

            return {
                "status": "error",
                "path": mp4_path,
                "new_path": webm_path,
                "reason": (
                    "WebM создан, но MP4 не удалось удалить: "
                    f"{e}"
                ),
                "original_size": original_size,
                "new_size": new_size,
                "saving": saving,
                "percent": percent,
                "crf": crf,
                "time": time.time() - start_time,
            }

        return {
            "status": "converted",
            "path": mp4_path,
            "new_path": webm_path,
            "original_size": original_size,
            "new_size": new_size,
            "saving": saving,
            "percent": percent,
            "crf": crf,
            "time": time.time() - start_time,
        }

    except Exception as e:

        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass

        return {
            "status": "error",
            "path": mp4_path,
            "reason": str(e),
            "time": time.time() - start_time,
        }


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 80)
    print("MP4 → WebM")
    print("=" * 80)
    print()
    print(f"Директория: {ROOT_DIR.resolve()}")
    print(f"Workers:    {WORKERS}")
    print(f"Base CRF:   {BASE_CRF}")
    print(f"CPU used:   {CPU_USED}")
    print()
    print("Ищем MP4...")

    if not ROOT_DIR.exists():
        print(f"ОШИБКА: директория не существует: {ROOT_DIR}")
        return

    files = sorted(
        path
        for path in ROOT_DIR.rglob("*")
        if path.is_file()
        and path.suffix.lower() == ".mp4"
    )

    print(f"Найдено: {len(files)}")
    print()

    if not files:
        return

    # --------------------------------------------------------
    # Резервируем места под progress bars
    # --------------------------------------------------------

    for i, path in enumerate(files):
        set_progress(i, path.name, 0)

    print("\n" * len(files))

    start = time.time()

    results = []

    # --------------------------------------------------------
    # Параллельная обработка
    # --------------------------------------------------------

    with ThreadPoolExecutor(
        max_workers=WORKERS
    ) as executor:

        futures = {
            executor.submit(
                convert_one,
                i,
                path
            ): i
            for i, path in enumerate(files)
        }

        for future in as_completed(futures):

            try:
                result = future.result()
            except Exception as e:
                result = {
                    "status": "error",
                    "path": files[futures[future]],
                    "reason": str(e),
                }

            results.append(result)

    # --------------------------------------------------------
    # Статистика
    # --------------------------------------------------------

    converted = [
        r for r in results
        if r["status"] == "converted"
    ]

    skipped = [
        r for r in results
        if r["status"] == "skipped"
    ]

    errors = [
        r for r in results
        if r["status"] == "error"
    ]

    total_original = sum(
        r.get("original_size", 0)
        for r in converted
    )

    total_new = sum(
        r.get("new_size", 0)
        for r in converted
    )

    total_saving = total_original - total_new

    total_percent = (
        total_saving / total_original * 100
        if total_original
        else 0
    )

    elapsed = time.time() - start

    print()
    print()
    print("=" * 80)
    print("ГОТОВО")
    print("=" * 80)

    print(f"Всего файлов:       {len(files)}")
    print(f"Заменено:           {len(converted)}")
    print(f"Пропущено:          {len(skipped)}")
    print(f"Ошибок:             {len(errors)}")
    print(f"Общее время:        {format_time(elapsed)}")

    # --------------------------------------------------------
    # Заменённые
    # --------------------------------------------------------

    if converted:

        print()
        print("-" * 80)
        print("ЗАМЕНЁННЫЕ ФАЙЛЫ")
        print("-" * 80)

        for r in sorted(
            converted,
            key=lambda x: x.get("saving", 0),
            reverse=True
        ):

            print()
            print(r["path"])
            print(f"  → {r['new_path']}")

            print(
                f"  {format_size(r['original_size'])}"
                f" → "
                f"{format_size(r['new_size'])}"
            )

            print(
                f"  Экономия: "
                f"{format_size(r['saving'])}"
                f" ({r['percent']:.1f}%)"
            )

            print(
                f"  CRF: {r['crf']}"
                f" | время: {format_time(r['time'])}"
            )

        print()
        print("-" * 80)
        print("ИТОГО")
        print("-" * 80)

        print(f"Было:               {format_size(total_original)}")
        print(f"Стало:              {format_size(total_new)}")

        print(
            f"Сэкономлено:        "
            f"{format_size(total_saving)} "
            f"({total_percent:.1f}%)"
        )

    # --------------------------------------------------------
    # Пропущенные
    # --------------------------------------------------------

    if skipped:

        print()
        print("-" * 80)
        print("ПРОПУЩЕННЫЕ")
        print("-" * 80)

        for r in sorted(
            skipped,
            key=lambda x: str(x["path"])
        ):

            print()
            print(r["path"])

            print(
                f"  MP4:  {format_size(r['original_size'])}"
            )

            print(
                f"  WebM: {format_size(r['new_size'])}"
            )

            print(
                "  WebM не меньше исходного — "
                "оригинал сохранён."
            )

    # --------------------------------------------------------
    # Ошибки
    # --------------------------------------------------------

    if errors:

        print()
        print("-" * 80)
        print("ОШИБКИ")
        print("-" * 80)

        for r in errors:

            print()
            print(r["path"])
            print(f"  {r['reason']}")

    print()
    print("=" * 80)


if __name__ == "__main__":
    main()