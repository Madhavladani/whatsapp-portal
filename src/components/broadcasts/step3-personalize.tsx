'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import {
  Contact,
  CustomField,
  MessageTemplate,
  TemplateHeaderMedia,
  TemplateHeaderMediaType,
} from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, ArrowRight, Eye, Loader2 } from 'lucide-react';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  headerMedia: TemplateHeaderMedia | null;
  onHeaderMediaChange: (media: TemplateHeaderMedia | null) => void;
  extraImages: TemplateHeaderMedia[];
  onExtraImagesChange: (media: TemplateHeaderMedia[]) => void;
  onNext: () => void;
  onBack: () => void;
}

const contactFields = [
  { value: 'name', label: 'Contact Name' },
  { value: 'phone', label: 'Phone Number' },
  { value: 'email', label: 'Email Address' },
  { value: 'company', label: 'Company' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMedia,
  onHeaderMediaChange,
  extraImages,
  onExtraImagesChange,
  onNext,
  onBack,
}: Step3Props) {
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const headerFileInputRef = useRef<HTMLInputElement | null>(null);
  const extraImagesInputRef = useRef<HTMLInputElement | null>(null);

  const headerType = template.header_type as TemplateHeaderMediaType | undefined;
  const needsHeaderMedia =
    headerType === 'image' || headerType === 'video' || headerType === 'document';

  function safeFilename(name: string) {
    const normalized = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
    return normalized.length > 0 ? normalized : `file-${Date.now()}`;
  }

  async function handleHeaderFile(file: File) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('Not signed in');

    const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';
    const path = `${user.id}/broadcast/${Date.now()}-${safeFilename(file.name)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('template_media')
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const {
      data: { publicUrl },
    } = supabase.storage.from('template_media').getPublicUrl(path);

    onHeaderMediaChange({
      type: headerType ?? 'document',
      url: publicUrl,
      filename: file.name,
    });
  }

  async function handleExtraImages(files: File[]) {
    if (files.length === 0) {
      onExtraImagesChange([]);
      return;
    }

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('Not signed in');

    const uploads = files.map(async (file) => {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';
      const path = `${user.id}/broadcast/${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}-${safeFilename(file.name)}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('template_media')
        .upload(path, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type,
        });
      if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

      const {
        data: { publicUrl },
      } = supabase.storage.from('template_media').getPublicUrl(path);

      return { type: 'image' as const, url: publicUrl, filename: file.name };
    });

    onExtraImagesChange(await Promise.all(uploads));
  }

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [template.body_text]);

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field source. Blocks Next until
   * every placeholder has something — otherwise the broadcast would
   * ship with empty strings and confuse recipients.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? { type: 'static' as VariableType, value: '' };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : 'sample data';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Personalize Message</h2>
        <p className="mt-1 text-sm text-slate-400">
          Map template variables to contact fields, custom fields, or static
          values.
        </p>
      </div>

      {needsHeaderMedia && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <p className="text-sm font-medium text-white">Header attachment</p>
          <p className="mt-1 text-xs text-slate-400">
            This template uses a {headerType} header. Upload the file you want
            WhatsApp to send with the template.
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1">
              <Input
                ref={headerFileInputRef}
                type="file"
                accept={
                  headerType === 'image'
                    ? 'image/*'
                    : headerType === 'video'
                      ? 'video/*'
                      : 'application/pdf'
                }
                disabled={uploadingHeader}
                className="border-slate-700 bg-slate-800 text-white file:text-slate-200"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploadingHeader(true);
                  try {
                    await handleHeaderFile(file);
                  } catch (err) {
                    const msg =
                      err instanceof Error ? err.message : 'Upload failed';
                    toast.error(msg);
                    onHeaderMediaChange(null);
                  } finally {
                    setUploadingHeader(false);
                    if (headerFileInputRef.current) {
                      headerFileInputRef.current.value = '';
                    }
                  }
                }}
              />
            </div>

            {headerMedia?.url ? (
              <Button
                type="button"
                variant="outline"
                className="border-slate-700 text-slate-300 hover:bg-slate-800"
                onClick={() => onHeaderMediaChange(null)}
                disabled={uploadingHeader}
              >
                Remove
              </Button>
            ) : (
              <div className="text-xs text-slate-500 sm:text-right">
                {uploadingHeader ? 'Uploading…' : 'No file selected'}
              </div>
            )}
          </div>

          {headerMedia?.url && (
            <p className="mt-2 text-xs text-slate-400">
              Attached:{' '}
              <span className="text-slate-200">
                {headerMedia.filename ?? 'file'}
              </span>
            </p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <p className="text-sm font-medium text-white">
          Additional images (optional)
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Send extra images after the template message.
        </p>

        <div className="mt-3">
          <Input
            ref={extraImagesInputRef}
            type="file"
            multiple
            accept="image/*"
            disabled={uploadingHeader}
            className="border-slate-700 bg-slate-800 text-white file:text-slate-200"
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              try {
                await handleExtraImages(files);
              } catch (err) {
                const msg = err instanceof Error ? err.message : 'Upload failed';
                toast.error(msg);
                onExtraImagesChange([]);
              } finally {
                if (extraImagesInputRef.current) {
                  extraImagesInputRef.current.value = '';
                }
              }
            }}
          />
          <p className="mt-2 text-xs text-slate-500">
            {extraImages.length > 0
              ? `${extraImages.length} image${extraImages.length === 1 ? '' : 's'} attached`
              : 'No extra images selected'}
          </p>
        </div>
      </div>

      {placeholders.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-center">
          <p className="text-sm text-slate-400">
            This template has no variables to personalize.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-violet-500/10 px-2 py-0.5 text-xs font-mono font-medium text-violet-400">
                    {placeholder}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">
                      Mapping Type
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-slate-700 bg-slate-800">
                        <SelectItem value="static">Static Value</SelectItem>
                        <SelectItem value="field">Contact Field</SelectItem>
                        <SelectItem value="custom_field">
                          Custom Field
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">
                      {mapping.type === 'static' ? 'Value' : 'Field'}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder="Enter value..."
                        className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                          <SelectValue placeholder="Select field..." />
                        </SelectTrigger>
                        <SelectContent className="border-slate-700 bg-slate-800">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {field.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? 'Loading…'
                                : customFields.length === 0
                                  ? 'No custom fields'
                                  : 'Select custom field…'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-slate-700 bg-slate-800">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp-style bubble so the user
          sees approximately what the recipient will see. */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="h-4 w-4 text-violet-400" />
          <p className="text-sm font-medium text-white">Live Preview</p>
          <span className="text-xs text-slate-500">({previewLabel})</span>
          {loadingPreview && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
          )}
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="ml-auto max-w-[85%] rounded-lg bg-violet-700/30 px-3 py-2 shadow-sm">
            <p className="whitespace-pre-wrap text-sm text-violet-50">
              {previewText}
            </p>
          </div>
        </div>
      </div>

      {unmappedKeys.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Map every placeholder before continuing — still missing{' '}
          <span className="font-mono font-semibold">
            {unmappedKeys.join(', ')}
          </span>
          . Otherwise those placeholders will ship to Meta as empty strings.
        </div>
      )}

      {needsHeaderMedia && !headerMedia?.url && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Upload a {headerType} header attachment before continuing.
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-800 pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-slate-700 text-slate-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button
          onClick={onNext}
          disabled={
            unmappedKeys.length > 0 || (needsHeaderMedia && !headerMedia?.url)
          }
          className="bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
