import { useEffect, useRef, useState } from 'react';
import { api, ApiError, mediaUrl } from '../api/client';
import type { Client, Pet } from '../api/types';
import { BreedInput } from '../components/BreedInput';
import { ageFromInput, ageToInput, type AgeUnit } from '../lib/age';
import { Icon } from '../components/Icon';
import {
  Button,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '../components/ui';
import {
  compressImage,
  formatBytes,
  UPLOADABLE_TYPES,
  validateImageFile,
} from '../lib/image';

type Props = {
  open: boolean;
  pet: Pet | null;
  clients: Client[];
  /** Campo que se quiere completar; se enfoca al abrir. */
  focusField?: string | null;
  onClose: () => void;
  onSaved: (pet: Pet, createdClient: boolean) => void;
};

/**
 * Alta y edición de mascota. Permite elegir un propietario existente o crear
 * uno nuevo sin salir del formulario: primero se crea el cliente y luego la
 * mascota, en dos llamadas a la API.
 */
export function PetEditor({
  open,
  pet,
  clients,
  focusField = null,
  onClose,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [clientId, setClientId] = useState<string>('');
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');

  const [name, setName] = useState('');
  const [species, setSpecies] = useState<'perro' | 'gato'>('perro');
  const [sex, setSex] = useState<'' | 'macho' | 'hembra'>('');
  const [breed, setBreed] = useState('');
  const [ageValue, setAgeValue] = useState('');
  const [ageUnit, setAgeUnit] = useState<AgeUnit>('years');
  const [weight, setWeight] = useState('');
  const [allergies, setAllergies] = useState('');
  const [temperament, setTemperament] = useState('');

  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoOriginalSize, setPhotoOriginalSize] = useState(0);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('existing');
    setClientId(pet ? String(pet.clientId) : '');
    setClientName('');
    setClientPhone('');
    setName(pet?.name ?? '');
    setSpecies(pet?.species ?? 'perro');
    setSex(pet?.sex ?? '');
    setBreed(pet?.breed ?? '');
    const age = ageToInput(pet?.ageYears);
    setAgeValue(age.value);
    setAgeUnit(age.unit);
    setWeight(pet?.weightKg ? String(pet.weightKg) : '');
    setAllergies(pet?.allergies ?? '');
    setTemperament(pet?.temperament ?? '');
    setPhotoBlob(null);
    setPhotoPreview(null);
    setPhotoOriginalSize(0);
    setRemovePhoto(false);
    setPhotoError(null);
    setPhotoBusy(false);
    setError(null);
    setBusy(false);
  }, [open, pet]);

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  async function onPhotoFile(file: File | undefined) {
    if (!file) return;
    setPhotoError(null);
    const problem = validateImageFile(file);
    if (problem) {
      setPhotoError(problem);
      return;
    }
    setPhotoBusy(true);
    try {
      const compressed = await compressImage(file);
      if (!UPLOADABLE_TYPES.includes(compressed.type)) {
        setPhotoError(
          'No pudimos convertir esta foto. Elige otra o expórtala como JPEG.',
        );
        return;
      }
      if (compressed.size > 5 * 1024 * 1024) {
        setPhotoError(
          'La imagen sigue siendo demasiado grande después de comprimir.',
        );
        return;
      }
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPhotoPreview(URL.createObjectURL(compressed));
      setPhotoBlob(compressed);
      setPhotoOriginalSize(file.size);
      setRemovePhoto(false);
    } catch {
      setPhotoError('No se pudo procesar la imagen.');
    } finally {
      setPhotoBusy(false);
    }
  }

  function clearPhoto() {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(null);
    setPhotoBlob(null);
    setPhotoOriginalSize(0);
    setRemovePhoto(true);
  }

  const existingPhoto = pet?.photoUrl ? mediaUrl(pet.photoUrl) : null;
  const shownPhoto = photoPreview ?? (removePhoto ? null : existingPhoto);

  async function save() {
    setBusy(true);
    setError(null);

    try {
      let ownerId = Number(clientId);

      if (!pet) {
        if (mode === 'new') {
          if (clientName.trim().length < 2 || clientPhone.trim().length < 7) {
            throw new ApiError(
              422,
              'validation_error',
              'Escribe el nombre y el teléfono del nuevo propietario.',
            );
          }
          const created = await api.clients.create({
            fullName: clientName.trim(),
            phone: clientPhone.trim(),
          });
          ownerId = created.data.id;
        }

        if (!ownerId) {
          throw new ApiError(422, 'validation_error', 'Elige un propietario.');
        }
      }

      const payload = {
        name: name.trim(),
        species,
        sex: sex === '' ? null : sex,
        breed: breed.trim() === '' ? null : breed.trim(),
        ageYears: ageFromInput(ageValue, ageUnit),
        weightKg: weight.trim() === '' ? null : Number(weight),
        allergies: allergies.trim() === '' ? null : allergies.trim(),
        temperament: temperament.trim() === '' ? null : temperament.trim(),
      };

      const result = pet
        ? await api.pets.update(pet.id, payload)
        : await api.pets.create({ ...payload, clientId: ownerId });

      let saved = result.data;
      let photoWarning: string | null = null;

      if (photoBlob) {
        try {
          const uploaded = await api.pets.uploadPhoto(saved.id, photoBlob);
          saved = uploaded.data;
        } catch (cause) {
          photoWarning =
            cause instanceof ApiError
              ? `La mascota se guardó, pero la foto no: ${cause.message}`
              : 'La mascota se guardó, pero la foto no se pudo subir.';
        }
      } else if (removePhoto && pet) {
        try {
          const removed = await api.pets.removePhoto(saved.id);
          saved = removed.data;
        } catch (cause) {
          photoWarning =
            cause instanceof ApiError
              ? `La mascota se guardó, pero no se pudo quitar la foto: ${cause.message}`
              : 'La mascota se guardó, pero no se pudo quitar la foto.';
        }
      }

      onSaved(saved, mode === 'new' && !pet);
      if (photoWarning) toast(photoWarning, 'warn');
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'No se pudo guardar la mascota.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={pet ? 'Editar mascota' : 'Nueva mascota'}
      subtitle={pet ? pet.name : 'El dueño puede ser nuevo o existente.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={photoBusy}>
            Guardar
          </Button>
        </>
      }
    >
      {error ? (
        <div className="login-error" style={{ marginBottom: 14 }}>
          {error}
        </div>
      ) : null}

      <div className="form-grid">
        <div className="span-2">
          <Field label="Nombre de la mascota">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Luna"
              autoFocus={focusField === null || focusField === 'name'}
            />
          </Field>
        </div>

        {pet ? (
          <div className="span-2">
            <Field label="Propietario">
              <Select value={clientId} onChange={(event) => setClientId(event.target.value)}>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.fullName ?? `Cliente ${client.id}`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <>
            <div className="span-2">
              <div className="segmented" role="group" aria-label="Propietario">
                <button
                  type="button"
                  aria-pressed={mode === 'existing'}
                  onClick={() => setMode('existing')}
                >
                  Cliente existente
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'new'}
                  onClick={() => setMode('new')}
                >
                  Cliente nuevo
                </button>
              </div>
            </div>

            {mode === 'existing' ? (
              <div className="span-2">
                <Field label="Propietario" hint="Un cliente puede tener varias mascotas">
                  <Select
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                  >
                    <option value="">Elige un cliente…</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.fullName ?? `Cliente ${client.id}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : (
              <>
                <Field label="Nombre del propietario">
                  <Input
                    value={clientName}
                    onChange={(event) => setClientName(event.target.value)}
                    placeholder="Ana Pérez"
                  />
                </Field>
                <Field label="Teléfono" hint="Se normaliza a +57…">
                  <Input
                    value={clientPhone}
                    onChange={(event) => setClientPhone(event.target.value)}
                    placeholder="312 575 4547"
                    inputMode="tel"
                  />
                </Field>
              </>
            )}
          </>
        )}

        <Field label="Especie">
          <Select
            value={species}
            autoFocus={focusField === 'species'}
            onChange={(event) =>
              setSpecies(event.target.value as 'perro' | 'gato')
            }
          >
            <option value="perro">Perro</option>
            <option value="gato">Gato</option>
          </Select>
        </Field>
        <Field label="Sexo">
          <Select
            value={sex}
            autoFocus={focusField === 'sex'}
            onChange={(event) => setSex(event.target.value as '' | 'macho' | 'hembra')}
          >
            <option value="">Sin definir</option>
            <option value="macho">Macho</option>
            <option value="hembra">Hembra</option>
          </Select>
        </Field>
        <Field label="Raza" hint="Escribe para buscar o crea una raza nueva">
          <BreedInput
            value={breed}
            onChange={setBreed}
            autoFocus={focusField === 'breed'}
          />
        </Field>
        <Field label="Peso (kg)" hint="Define el tamaño: pequeño, mediano o grande">
          <Input
            type="number"
            step="0.1"
            min="0"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
            inputMode="decimal"
            autoFocus={focusField === 'sizeOrWeight'}
          />
        </Field>
        <Field label="Edad" hint="Elige meses o años y escribe el número">
          <div className="row" style={{ gap: 8 }}>
            <Input
              type="number"
              min="0"
              step={ageUnit === 'months' ? '1' : '0.5'}
              value={ageValue}
              onChange={(event) => setAgeValue(event.target.value)}
              inputMode="decimal"
              autoFocus={focusField === 'age'}
              style={{ flex: 1 }}
            />
            <Select
              value={ageUnit}
              onChange={(event) => setAgeUnit(event.target.value as AgeUnit)}
              style={{ maxWidth: 120 }}
            >
              <option value="years">Años</option>
              <option value="months">Meses</option>
            </Select>
          </div>
        </Field>
        <div className="span-2">
          <div className="field">
            <span className="field-label">Fotografía</span>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                void onPhotoFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                void onPhotoFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <div className="photo-picker-actions photo-picker-actions-start">
              <Button
                icon="camera"
                onClick={() => cameraRef.current?.click()}
              >
                Tomar foto
              </Button>
              <Button
                icon="box"
                onClick={() => fileRef.current?.click()}
              >
                Subir archivo
              </Button>
              {shownPhoto ? (
                <Button
                  variant="subtle"
                  icon="trash"
                  onClick={clearPhoto}
                >
                  Quitar
                </Button>
              ) : null}
            </div>
            <div className="photo-picker photo-picker-editor">
              {shownPhoto ? (
                <img
                  src={shownPhoto}
                  alt="Vista previa de la mascota"
                  className="photo-picker-preview"
                />
              ) : (
                <div className="photo-picker-empty">
                  <Icon name="camera" size={28} />
                  <span>Sin fotografía</span>
                </div>
              )}
            </div>
            {photoBusy ? (
              <span className="field-hint">Procesando foto…</span>
            ) : photoError ? (
              <span className="field-error">{photoError}</span>
            ) : photoBlob ? (
              <span className="field-hint">
                {formatBytes(photoOriginalSize)} → {formatBytes(photoBlob.size)}{' '}
                después de comprimir
              </span>
            ) : (
              <span className="field-hint">
                JPEG, PNG, WebP o HEIC. Se comprime antes de subir. Solo tú
                puedes verla.
              </span>
            )}
          </div>
        </div>
        <div className="span-2">
          <Field label="Alergias">
            <Input
              value={allergies}
              onChange={(event) => setAllergies(event.target.value)}
              placeholder="Pollo, shampoo con perfume…"
            />
          </Field>
        </div>
        <div className="span-2">
          <Field label="Observaciones">
            <Textarea
              value={temperament}
              onChange={(event) => setTemperament(event.target.value)}
              placeholder="Tranquila, nerviosa con la secadora, muerde el cepillo…"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
