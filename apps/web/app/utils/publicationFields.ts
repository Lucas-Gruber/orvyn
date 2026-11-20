export interface PublicationFieldChoice {
  id: string;
  allowed: boolean;
  dependencies?: { id: string; name: string }[];
}
export function missingPublicationInputs(
  property: PublicationFieldChoice,
  selected: string[],
) {
  return (property.dependencies || []).filter(
    (dependency) => !selected.includes(dependency.id),
  );
}
export function retainPublicationFields(
  selected: string[],
  properties: PublicationFieldChoice[],
) {
  let result = selected.filter((id) =>
    properties.some((property) => property.id === id && property.allowed),
  );
  for (let pass = 0; pass < properties.length; pass++) {
    const next = result.filter((id) => {
      const property = properties.find((property) => property.id === id)!;
      return !missingPublicationInputs(property, result).length;
    });
    if (next.length === result.length) return next;
    result = next;
  }
  return result;
}
