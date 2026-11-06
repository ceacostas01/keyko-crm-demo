import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Icon } from '../components/Icon';
import { Button, Modal, useToast } from '../components/ui';
import {
  compressImage,
  formatBytes,
  UPLOADABLE_TYPES,
  validateImageFile,
} from '../lib/image';

type Props = {
  open: boolean;
  petId: string;
  petName: string;
  hasPhoto: boolean;
  onClose: () => void;
  onSaved: () => void;
};

/**
 * Subida de fotos desde cámara o galería.
 *
 * La imagen se valida y comprime en el navegador antes de enviarse. El
 * servidor vuelve a validar el tipo real y el tamaño.
 */
export function PetPhotoModal({
  open,
  petId,
  petName,
  hasPhoto,
  onClose,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [originalSize, setOriginalSize] = useState(0);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setBlob(null);
    setError(null);
    setPhotoBusy(false);
    setOriginalSize(0);
    setConfirmRemove(false);
  }, [open]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);

    const problem = validateImageFile(file);
    if (problem) {
      setError(problem);
      return;
    }

    setPhotoBusy(true);
    try {
      const compressed = await compressImage(file);
      if (!UPLOADABLE_TYPES.includes(compressed.type)) {
        setError(
          'No pudimos convertir esta foto. Elige otra o expórtala como JPEG.',
        );
        return;
      }
      if (compressed.size > 5 * 1024 * 1024) {
        setError('La imagen sigue siendo demasiado grande después de comprimir.');
        return;
      }

      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(compressed));
      setBlob(compressed);
      setOriginalSize(file.size);
    } catch {
      setError('No se pudo procesar la imagen.');
    } finally {
      setPhotoBusy(false);
    }
  }

  async function save() {
    if (!blob) return;
    setBusy(true);
    setError(null);
    try {
      await api.pets.uploadPhoto(petId, blob);
      toast('Fotografía guardada.');
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo subir.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.pets.removePhoto(petId);
      toast('Fotografía eliminada.');
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo quitar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={`Foto de ${petName}`}
      subtitle="Se comprime antes de subir. Solo tú puedes verla."
      onClose={onClose}
      footer={
        <>
          {hasPhoto ? (
            confirmRemove ? (
              <Button variant="danger" onClick={remove} loading={busy}>
                Confirmar borrado
              </Button>
            ) : (
              <Button variant="subtle" icon="trash" onClick={() => setConfirmRemove(true)}>
                Quitar foto
              </Button>
            )
          ) : null}
          <span className="grow" />
          <Button onClick={onClose} disabled={busy}>
            Cerrar
          </Button>
          <Button
            variant="primary"
            onClick={save}
            loading={busy || photoBusy}
            disabled={!blob || photoBusy}
          >
            Guardar foto
          </Button>
        </>
      }
    >
      {error ? (
        <div className="login-error" style={{ marginBottom: 14 }}>
          {error}
        </div>
      ) : null}
      {photoBusy ? (
        <p className="muted small" style={{ textAlign: 'center' }}>
          Procesando foto…
        </p>
      ) : null}

      <div className="photo-picker">
        {preview ? (
          <img src={preview} alt="Vista previa" className="photo-picker-preview" />
        ) : (
          <div className="photo-picker-empty">
            <Icon name="paw" size={28} />
            <span>Sin foto seleccionada</span>
          </div>
        )}
      </div>

      {blob ? (
        <p className="muted small" style={{ textAlign: 'center' }}>
          {formatBytes(originalSize)} → {formatBytes(blob.size)} después de comprimir
        </p>
      ) : null}

      <div className="photo-picker-actions">
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(event) => {
            void onFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            void onFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        <Button icon="sparkle" onClick={() => cameraRef.current?.click()} disabled={busy}>
          Tomar foto
        </Button>
        <Button icon="plus" onClick={() => fileRef.current?.click()} disabled={busy}>
          Elegir archivo
        </Button>
      </div>

      <p className="muted small" style={{ marginTop: 10 }}>
        JPEG, PNG, WebP o HEIC · hasta 30 MB de origen. Se redimensiona a
        1600 px, se comprime y se guarda en almacenamiento privado.
      </p>
    </Modal>
  );
}
