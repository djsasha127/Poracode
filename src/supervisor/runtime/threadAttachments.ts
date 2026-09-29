import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { PromptSegment, ProjectLocation } from "@/shared/contracts";
import { isPdfPath } from "@/shared/promptContent";
import type { WslBridgeClient, WslLocation } from "../wsl/bridge/client";

const wslAttachmentDirCache = new Map<string, { home: string; linuxDir: string }>();
let wslAttachmentBridgeClient: WslBridgeClient | undefined;
let convertedAttachmentDir: Promise<string> | undefined;
const preparedAttachmentCache = new Map<string, string>();
const CONVERTIBLE_IMAGE_EXTENSION = /\.(?:svg|bmp|ico|avif)$/i;
const EXTRACTABLE_OFFICE_EXTENSION = /\.(?:docx|pptx|xlsx)$/i;
const MAX_CONVERTIBLE_IMAGE_BYTES = 50 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** Reject attachment paths that the provider would otherwise receive silently. */
export async function validateAttachmentSegments(
  segments: PromptSegment[] | undefined,
): Promise<void> {
  if (!segments) return;
  for (const segment of segments) {
    if (segment.kind !== "attachment") continue;
    const label = basename(segment.path) || segment.path;
    let metadata;
    try {
      metadata = await stat(segment.path);
    } catch (error) {
      throw new Error(`Attachment is unavailable: ${label}`, { cause: error });
    }
    if (!metadata.isFile()) {
      throw new Error(`Attachment is not a readable file: ${label}`);
    }
  }
}

export function setWslAttachmentBridgeClient(client: WslBridgeClient | undefined): void {
  wslAttachmentBridgeClient = client;
}

function conversionDir(): Promise<string> {
  convertedAttachmentDir ??= mkdtemp(join(tmpdir(), "poracode-attachments-"));
  return convertedAttachmentDir;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function xmlTagText(xml: string, tag: string): string[] {
  const expression = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...xml.matchAll(expression)].map((match) =>
    decodeXmlText((match[1] ?? "").replace(/<[^>]+>/g, "")),
  );
}

async function unzipEntry(path: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync("unzip", ["-p", path, entry], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function listZipEntries(path: string): Promise<string[]> {
  const { stdout } = await execFileAsync("unzip", ["-Z1", path], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function extractOfficeText(path: string): Promise<string> {
  const extension = extname(path).toLowerCase();
  if (extension === ".docx") {
    const xml = await unzipEntry(path, "word/document.xml");
    return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
      .map((paragraph) => xmlTagText(paragraph[1] ?? "", "w:t").join(""))
      .join("\n");
  }

  const entries = await listZipEntries(path);
  if (extension === ".pptx") {
    const slides = entries
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const sections: string[] = [];
    for (const [index, entry] of slides.entries()) {
      const xml = await unzipEntry(path, entry);
      sections.push(`Slide ${index + 1}\n${xmlTagText(xml, "a:t").join("\n")}`);
    }
    return sections.join("\n\n");
  }

  const sharedEntry = entries.find((entry) => entry === "xl/sharedStrings.xml");
  const sharedStrings = sharedEntry ? xmlTagText(await unzipEntry(path, sharedEntry), "t") : [];
  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const sections: string[] = [];
  for (const [index, entry] of sheets.entries()) {
    const xml = await unzipEntry(path, entry);
    const values = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((match) => {
      const attrs = match[1] ?? "";
      const body = match[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (/\bt="s"/.test(attrs) && raw !== undefined) {
        return sharedStrings[Number(raw)] ?? raw;
      }
      const inline = xmlTagText(body, "t").join("");
      return decodeXmlText(inline || raw || "");
    });
    sections.push(`Sheet ${index + 1}\n${values.join("\t")}`);
  }
  return sections.join("\n\n");
}

/** Convert non-native vision formats to PNG before a structured provider sees them. */
export async function prepareStructuredAttachmentSegments(
  segments: PromptSegment[] | undefined,
): Promise<PromptSegment[] | undefined> {
  await validateAttachmentSegments(segments);
  if (
    !segments?.some(
      (segment) =>
        segment.kind === "attachment" &&
        (CONVERTIBLE_IMAGE_EXTENSION.test(segment.path) ||
          EXTRACTABLE_OFFICE_EXTENSION.test(segment.path)),
    )
  ) {
    return segments;
  }

  const prepared: PromptSegment[] = [];
  for (const segment of segments) {
    if (
      segment.kind !== "attachment" ||
      (!CONVERTIBLE_IMAGE_EXTENSION.test(segment.path) &&
        !EXTRACTABLE_OFFICE_EXTENSION.test(segment.path))
    ) {
      prepared.push(segment);
      continue;
    }
    const metadata = await stat(segment.path);
    if (!metadata.isFile()) {
      throw new Error(`Attachment is not a readable file: ${basename(segment.path)}`);
    }
    if (metadata.size > MAX_CONVERTIBLE_IMAGE_BYTES) {
      throw new Error(`Attachment is too large to prepare: ${basename(segment.path)}`);
    }
    const isOffice = EXTRACTABLE_OFFICE_EXTENSION.test(segment.path);
    const cacheKey = `${segment.path}:${metadata.mtimeMs}:${metadata.size}`;
    let outputPath = preparedAttachmentCache.get(cacheKey);
    if (!outputPath) {
      const root = await conversionDir();
      const safeStem = basename(segment.path, extname(segment.path)).replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
      outputPath = join(
        root,
        `${safeStem || (isOffice ? "document" : "image")}-${preparedAttachmentCache.size}.${isOffice ? "txt" : "png"}`,
      );
      try {
        if (isOffice) {
          const text = (await extractOfficeText(segment.path)).trim();
          if (!text) throw new Error("The document contains no extractable text.");
          await writeFile(outputPath, text, "utf8");
        } else {
          await sharp(segment.path, { limitInputPixels: 100_000_000 }).png().toFile(outputPath);
        }
      } catch (error) {
        throw new Error(
          isOffice
            ? `Could not extract text from attachment ${basename(segment.path)}.`
            : `Could not convert image attachment ${basename(segment.path)} to PNG.`,
          { cause: error },
        );
      }
      preparedAttachmentCache.set(cacheKey, outputPath);
    }
    prepared.push({
      ...segment,
      path: outputPath,
      mimeType: isOffice ? "text/plain" : "image/png",
    });
  }
  return prepared;
}

function attachmentLocation(
  distro: string,
  linuxDir: string,
): Extract<ProjectLocation, { kind: "wsl" }> {
  return {
    kind: "wsl",
    distro,
    linuxPath: linuxDir,
    uncPath: `\\\\wsl.localhost\\${distro}\\`,
  };
}

async function resolveWslAttachmentDirs(
  client: WslBridgeClient,
  distro: string,
): Promise<{ home: string; linuxDir: string }> {
  const cached = wslAttachmentDirCache.get(distro);
  if (cached) {
    return cached;
  }

  const rootLocation: WslLocation = {
    kind: "wsl",
    distro,
    linuxPath: "/",
    uncPath: `\\\\wsl.localhost\\${distro}\\`,
  };
  const { home } = await client.home(rootLocation);
  const linuxDir = `${home}/.poracode/attachments`;
  const location = attachmentLocation(distro, linuxDir);
  await client.mkdir(location, linuxDir, { recursive: true });

  const entry = { home, linuxDir };
  wslAttachmentDirCache.set(distro, entry);
  return entry;
}

function isImageAttachmentSegment(segment: PromptSegment): boolean {
  if (segment.kind !== "attachment") {
    return false;
  }
  return (
    segment.mimeType?.startsWith("image/") === true ||
    /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(segment.path)
  );
}

/** A segment that carries a filesystem path eligible for copy/rewrite. */
function isRewritableFileSegment(
  segment: PromptSegment,
): segment is Extract<PromptSegment, { kind: "attachment" | "file" }> {
  return (segment.kind === "attachment" || segment.kind === "file") && Boolean(segment.path);
}

export async function rewriteSegmentsForWsl(
  segments: PromptSegment[],
  location: ProjectLocation,
  options?: { preserveImageAttachments?: boolean; preservePdfAttachments?: boolean },
): Promise<PromptSegment[]> {
  if (location.kind !== "wsl") {
    return segments;
  }

  const client = wslAttachmentBridgeClient;
  if (!client) return segments;

  let dirs: { home: string; linuxDir: string } | undefined;
  const rewritten: PromptSegment[] = [];
  for (const segment of segments) {
    if (!isRewritableFileSegment(segment)) {
      rewritten.push(segment);
      continue;
    }
    if (options?.preserveImageAttachments && isImageAttachmentSegment(segment)) {
      rewritten.push(segment);
      continue;
    }
    if (
      options?.preservePdfAttachments &&
      segment.kind === "attachment" &&
      isPdfPath(segment.path, segment.mimeType)
    ) {
      rewritten.push(segment);
      continue;
    }
    if (!/^[A-Za-z]:[\\/]/.test(segment.path)) {
      rewritten.push(segment);
      continue;
    }

    dirs ??= await resolveWslAttachmentDirs(client, location.distro);
    const fileName = basename(segment.path);
    const linuxPath = `${dirs.linuxDir}/${fileName}`;
    const bridgeLocation = attachmentLocation(location.distro, dirs.linuxDir);
    try {
      const content = await readFile(segment.path);
      await client.rm(bridgeLocation, linuxPath, { force: true });
      await client.writeNewFile(bridgeLocation, linuxPath, content);
    } catch (error) {
      throw new Error(`Could not copy attachment into WSL: ${fileName}`, { cause: error });
    }
    rewritten.push({ ...segment, path: linuxPath });
  }
  return rewritten;
}

const WORKSPACE_ATTACHMENT_DIR = ".poracode";
const WORKSPACE_ATTACHMENT_SUBDIR = "attachments";

function isInsideDir(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Copies any attachment/file segment that lives outside `projectDir` into
 * `<projectDir>/.poracode/attachments` and rewrites its path there. Some agents
 * (e.g. Command Code) sandbox file reads to their working directory, so a
 * picker screenshot in `~/.poracode/attachments` is otherwise unreadable. The
 * copied files self-ignore via a `.poracode/.gitignore` so they never show up
 * in `git status`. Paths already inside the workspace are left untouched.
 */
export async function rewriteSegmentsForWorkspace(
  segments: PromptSegment[],
  projectDir: string,
): Promise<PromptSegment[]> {
  const attachmentsDir = join(projectDir, WORKSPACE_ATTACHMENT_DIR, WORKSPACE_ATTACHMENT_SUBDIR);
  let prepared = false;
  const rewritten: PromptSegment[] = [];
  for (const segment of segments) {
    if (!isRewritableFileSegment(segment)) {
      rewritten.push(segment);
      continue;
    }
    if (!isAbsolute(segment.path) || isInsideDir(segment.path, projectDir)) {
      rewritten.push(segment);
      continue;
    }
    try {
      if (!prepared) {
        await mkdir(attachmentsDir, { recursive: true });
        const gitignorePath = join(projectDir, WORKSPACE_ATTACHMENT_DIR, ".gitignore");
        if (!existsSync(gitignorePath)) {
          await writeFile(gitignorePath, "*\n");
        }
        prepared = true;
      }
      const dest = join(attachmentsDir, basename(segment.path));
      await copyFile(segment.path, dest);
      rewritten.push({ ...segment, path: dest });
    } catch (error) {
      throw new Error(`Could not copy attachment into the workspace: ${basename(segment.path)}`, {
        cause: error,
      });
    }
  }
  return rewritten;
}
