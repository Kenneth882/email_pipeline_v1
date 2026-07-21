import { downloadUnipileAttachment } from "@/lib/unipile/send";
import type { TriageAttachment, TriageAttachmentText } from "@/lib/triage/schema";

export const MAX_PDF_FILES = 2;
export const MAX_PDF_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_TEXT_PER_FILE = 6000;
export const MAX_TEXT_TOTAL = 8000;

export type PdfExtractResult = {
  texts: TriageAttachmentText[];
  unread: string[];
  pending: boolean;
};

export function isPdfAttachment(a: {
  filename: string;
  mimeType: string;
}): boolean {
  return (
    /application\/pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename)
  );
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extract plain text from a PDF buffer via unpdf.
 * Empty / whitespace-only → treat as unread (scanned/image PDF).
 */
export async function extractTextFromPdfBuffer(
  buffer: Buffer,
): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return normalizeWhitespace(typeof text === "string" ? text : "");
}

type DownloadFn = (emailId: string, attachmentId: string) => Promise<Buffer>;

/**
 * Download + extract up to MAX_PDF_FILES PDFs. Caps size and text length.
 * Failures / empty extract → unread list + pending.
 */
export async function extractPdfAttachments(
  emailId: string,
  attachments: TriageAttachment[],
  opts?: { download?: DownloadFn },
): Promise<PdfExtractResult> {
  const download = opts?.download ?? downloadUnipileAttachment;
  const pdfs = attachments.filter(isPdfAttachment).slice(0, MAX_PDF_FILES);

  if (pdfs.length === 0) {
    return { texts: [], unread: [], pending: false };
  }

  const texts: TriageAttachmentText[] = [];
  const unread: string[] = [];
  let totalChars = 0;

  for (const att of pdfs) {
    if (totalChars >= MAX_TEXT_TOTAL) {
      unread.push(att.filename);
      continue;
    }

    if (typeof att.size === "number" && att.size > MAX_PDF_BYTES) {
      unread.push(att.filename);
      continue;
    }

    if (!att.id?.trim()) {
      unread.push(att.filename);
      continue;
    }

    try {
      const buf = await download(emailId, att.id);
      if (buf.byteLength > MAX_PDF_BYTES) {
        unread.push(att.filename);
        continue;
      }

      const raw = await extractTextFromPdfBuffer(buf);
      if (!raw) {
        unread.push(att.filename);
        continue;
      }

      const room = MAX_TEXT_TOTAL - totalChars;
      const capped = raw.slice(0, Math.min(MAX_TEXT_PER_FILE, room));
      if (!capped) {
        unread.push(att.filename);
        continue;
      }

      texts.push({ filename: att.filename, text: capped });
      totalChars += capped.length;
    } catch (err) {
      console.warn("[triage/pdf] extract failed", att.filename, err);
      unread.push(att.filename);
    }
  }

  // Any PDF beyond the file cap counts as unread.
  for (const extra of attachments.filter(isPdfAttachment).slice(MAX_PDF_FILES)) {
    unread.push(extra.filename);
  }

  return {
    texts,
    unread,
    pending: unread.length > 0,
  };
}
