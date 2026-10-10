/**
 * Barrel export for the data-access layer.
 *
 * Controllers and services import from here rather than reaching into
 * `config/db.js` directly. That indirection is what makes the storage
 * engine swappable: nothing above this line knows that the data lives in
 * PostgreSQL rather than a JSON file.
 */
export { default as userRepo } from "./userRepo.js";
export { default as doctorRepo } from "./doctorRepo.js";
export { default as slotRepo } from "./slotRepo.js";
export { default as appointmentRepo } from "./appointmentRepo.js";
export { default as queueRepo } from "./queueRepo.js";
export { default as notificationRepo } from "./notificationRepo.js";
export { default as analyticsRepo } from "./analyticsRepo.js";
export {
  specialties,
  facilities,
  services,
} from "./referenceRepo.js";
export { default as triageRepo } from "./triageRepo.js";
