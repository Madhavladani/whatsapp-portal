"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { MessageTemplate, TemplateHeaderMedia, TemplateHeaderMediaType } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
} from "lucide-react";

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (
    template: MessageTemplate,
    params: string[],
    headerMedia?: TemplateHeaderMedia | null,
    extraImages?: TemplateHeaderMedia[]
  ) => void;
}

// Meta numbers template placeholders from 1 ({{1}}, {{2}}, …) and the
// indices passed to the Graph API must be contiguous starting at 1.
// We sort + dedupe here so a body using only {{2}} still drives a single
// input slot, and so render-order matches send-order.
function extractVariables(body: string): number[] {
  const ids = new Set<number>();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) {
    ids.add(Number(m[1]));
  }
  return Array.from(ids).sort((a, b) => a - b);
}

function renderBodyPreview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [extraImageFiles, setExtraImageFiles] = useState<File[]>([]);
  const [uploadingHeader, setUploadingHeader] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (!cancelled) {
          setTemplates([]);
          setUserId(null);
          setLoading(false);
        }
        return;
      }

      setUserId(user.id);

      // Only Approved templates are sendable through Meta — anything else
      // would 400 on the send route. Hide them rather than letting the
      // user pick a template that will be rejected.
      const { data, error } = await supabase
        .from("message_templates")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "Approved")
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch templates:", error);
        setTemplates([]);
      } else {
        setTemplates((data as MessageTemplate[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSelected(null);
      setParams([]);
      setHeaderFile(null);
      setExtraImageFiles([]);
    }
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const vars = extractVariables(template.body_text);
    setSelected(template);
    setParams(new Array(vars.length).fill(""));
    setHeaderFile(null);
    setExtraImageFiles([]);
  }

  function safeFilename(name: string) {
    const normalized = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return normalized.length > 0 ? normalized : `file-${Date.now()}`;
  }

  async function uploadHeaderMedia(args: {
    userId: string;
    headerType: TemplateHeaderMediaType;
    file: File;
  }): Promise<TemplateHeaderMedia> {
    const supabase = createClient();
    const ext = args.file.name.split(".").pop()?.toLowerCase() || "bin";
    const path = `${args.userId}/inbox/${Date.now()}-${safeFilename(args.file.name)}.${ext}`;

    const { error } = await supabase.storage.from("template_media").upload(path, args.file, {
      cacheControl: "3600",
      upsert: false,
      contentType: args.file.type,
    });
    if (error) throw new Error(`Upload failed: ${error.message}`);

    const {
      data: { publicUrl },
    } = supabase.storage.from("template_media").getPublicUrl(path);

    return { type: args.headerType, url: publicUrl, filename: args.file.name };
  }

  async function uploadExtraImages(args: {
    userId: string;
    files: File[];
  }): Promise<TemplateHeaderMedia[]> {
    if (args.files.length === 0) return [];
    const supabase = createClient();

    const uploads = args.files.map(async (file) => {
      const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
      const path = `${args.userId}/inbox/${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}-${safeFilename(file.name)}.${ext}`;

      const { error } = await supabase.storage.from("template_media").upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type,
      });
      if (error) throw new Error(`Upload failed: ${error.message}`);

      const {
        data: { publicUrl },
      } = supabase.storage.from("template_media").getPublicUrl(path);

      return { type: "image" as const, url: publicUrl, filename: file.name };
    });

    return Promise.all(uploads);
  }

  async function confirm() {
    if (!selected) return;

    const headerType = selected.header_type as TemplateHeaderMediaType | undefined;
    const needsHeaderMedia =
      headerType === "image" || headerType === "video" || headerType === "document";

    try {
      setUploadingHeader(true);
      const headerMedia =
        needsHeaderMedia && userId && headerType && headerFile
          ? await uploadHeaderMedia({ userId, headerType, file: headerFile })
          : null;
      const extraImages =
        userId && extraImageFiles.length > 0
          ? await uploadExtraImages({ userId, files: extraImageFiles })
          : [];
      onSelect(selected, params, headerMedia, extraImages);
      handleOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send template";
      toast.error(msg);
    } finally {
      setUploadingHeader(false);
    }
  }

  const variables = selected ? extractVariables(selected.body_text) : [];
  const headerType = (selected?.header_type as TemplateHeaderMediaType | undefined) ?? undefined;
  const needsHeaderMedia =
    headerType === "image" || headerType === "video" || headerType === "document";
  const canConfirm =
    !!selected &&
    variables.every((_, i) => (params[i] ?? "").trim().length > 0) &&
    (!needsHeaderMedia || headerFile !== null) &&
    !uploadingHeader;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-slate-700 bg-slate-900 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <LayoutTemplate className="h-4 w-4 text-violet-400" />
            {selected ? selected.name : "Send template"}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            {selected
              ? "Fill in the placeholders to render this template. Meta requires every variable to be set."
              : "Pick an approved WhatsApp template to send to this contact."}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-violet-400" />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-md border border-slate-800 bg-slate-950/50 p-6 text-center">
                <p className="text-sm text-slate-300">No approved templates</p>
                <p className="mt-1 text-xs text-slate-500">
                  Approve a template in Meta WhatsApp Manager, then sync it
                  from Settings → Templates.
                </p>
              </div>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  className="w-full rounded-md border border-slate-800 bg-slate-950/50 p-3 text-left transition-colors hover:border-violet-500/40 hover:bg-slate-900"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-white">
                          {t.name}
                        </p>
                        <Badge className="border border-violet-600/30 bg-violet-600/20 text-[10px] text-violet-400">
                          {t.category}
                        </Badge>
                        {t.language && (
                          <span className="text-[10px] uppercase text-slate-500">
                            {t.language}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                        {t.body_text}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-500" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <p className="mb-1 text-xs text-slate-400">Preview</p>
              <p className="whitespace-pre-wrap text-sm text-slate-200">
                {renderBodyPreview(selected.body_text, params)}
              </p>
              {selected.footer_text && (
                <p className="mt-2 text-xs italic text-slate-500">
                  {selected.footer_text}
                </p>
              )}
            </div>

            {needsHeaderMedia && (
              <div className="space-y-1">
                <Label className="text-xs text-slate-300">
                  {headerType === "document" ? "PDF attachment" : "Header media"}
                </Label>
                <Input
                  type="file"
                  accept={
                    headerType === "image"
                      ? "image/*"
                      : headerType === "video"
                        ? "video/*"
                        : "application/pdf"
                  }
                  disabled={uploadingHeader}
                  className="border-slate-700 bg-slate-800 text-white file:text-slate-200"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setHeaderFile(file);
                  }}
                />
                <p className="text-[11px] text-slate-500">
                  This template has a {headerType} header. Select a file to include with the message.
                </p>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs text-slate-300">Additional images (optional)</Label>
              <Input
                type="file"
                multiple
                accept="image/*"
                disabled={uploadingHeader}
                className="border-slate-700 bg-slate-800 text-white file:text-slate-200"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  setExtraImageFiles(files);
                }}
              />
              {extraImageFiles.length > 0 ? (
                <p className="text-[11px] text-slate-500">
                  {extraImageFiles.length} image{extraImageFiles.length === 1 ? "" : "s"} selected
                </p>
              ) : (
                <p className="text-[11px] text-slate-500">No extra images selected</p>
              )}
            </div>
            {variables.map((v, i) => (
              <div key={v} className="space-y-1">
                <Label className="text-xs text-slate-300">{`Variable {{${v}}}`}</Label>
                <Input
                  value={params[i] ?? ""}
                  onChange={(e) => {
                    const next = [...params];
                    next[i] = e.target.value;
                    setParams(next);
                  }}
                  placeholder={`Value for {{${v}}}`}
                  className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
                />
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setSelected(null);
                  setParams([]);
                }}
                className="border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
              >
                Send template
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
