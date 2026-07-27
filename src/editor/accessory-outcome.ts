/**
 * The frozen accessory-review disposition contract.
 *
 * Lives in its own module so both the accessory implementation and external
 * consumers (crouter) share exactly one declaration of the shape.
 */
export type AccessoryOutcome =
  | { kind: 'insert'; text: string }
  | { kind: 'copy'; text: string }
  | { kind: 'cancel' };
