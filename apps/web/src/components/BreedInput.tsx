import { useMemo, useState } from 'react';
import { Input } from './ui';

/**
 * Razas frecuentes en Keyko. La lista es una ayuda: se puede escribir
 * cualquier otra raza. "Criollo/a" se ofrece como una raza más.
 */
const BREEDS = [
  'Criollo/a',
  'Beagle',
  'Poodle',
  'French Poodle',
  'Golden Retriever',
  'Labrador Retriever',
  'Pastor Alemán',
  'Border Collie',
  'Bulldog Francés',
  'Bulldog Inglés',
  'Schnauzer',
  'Cocker Spaniel',
  'Yorkshire Terrier',
  'Chihuahua',
  'Shih Tzu',
  'Pomerania',
  'Husky Siberiano',
  'Dálmata',
  'Boxer',
  'Rottweiler',
  'Pitbull',
  'Maltés',
  'Bichón Frisé',
  'Siamés',
  'Persa',
  'Angora',
  'Bengalí',
  'Maine Coon',
  'Ragdoll',
  'British Shorthair',
  'Esfinge',
  'Abisinio',
];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function BreedInput({
  value,
  onChange,
  autoFocus = false,
  placeholder = 'Ej.: Criollo/a, Beagle, Siamés…',
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const query = normalize(value);
    const list = query
      ? BREEDS.filter((breed) => normalize(breed).includes(query))
      : BREEDS;
    return list.slice(0, 8);
  }, [value]);

  function choose(breed: string) {
    onChange(breed);
    setOpen(false);
  }

  return (
    <div className="breed-input">
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((current) =>
              Math.min(current + 1, Math.max(matches.length - 1, 0)),
            );
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) => Math.max(current - 1, 0));
          } else if (event.key === 'Enter' && open && matches[active]) {
            event.preventDefault();
            choose(matches[active] as string);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && matches.length > 0 ? (
        <div className="breed-suggestions" role="listbox">
          {matches.map((breed, index) => (
            <button
              key={breed}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? 'is-active' : ''}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(breed);
              }}
            >
              {breed}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
