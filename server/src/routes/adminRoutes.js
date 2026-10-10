import { Router } from "express";
import * as ctrl from "../controllers/adminController.js";
import { requireAuth, requireRole } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";

const router = Router();

// Every admin route is authenticated *and* role-gated.
router.use(requireAuth, requireRole("admin"));

/* ---------------- dashboard / analytics ---------------- */
router.get("/overview", ctrl.overview);

/* ---------------- doctors ---------------- */
router.get(
  "/doctors",
  validate(
    {
      search: { type: "string", maxLength: 120 },
      specialty: { type: "string", maxLength: 120 },
      city: { type: "string", maxLength: 80 },
      facilityId: { type: "string", maxLength: 64 },
      accepting: { type: "boolean" },
      limit: { type: "number", min: 1, max: 100 },
      offset: { type: "number", min: 0 },
    },
    "query",
  ),
  ctrl.listDoctorsAdmin,
);
router.patch(
  "/doctors/:id",
  validate({ id: { type: "string", minLength: 1, maxLength: 64 } }, "params"),
  validate({
    isAcceptingNew: { type: "boolean" },
    consultationFee: { type: "number", min: 0 },
    facilityId: { type: "string", maxLength: 64 },
    experience: { type: "number", min: 0, max: 70 },
    bio: { type: "string", maxLength: 2000 },
    qualification: { type: "string", maxLength: 240 },
  }),
  ctrl.updateDoctor,
);

/* ---------------- facilities ---------------- */
const FACILITY_FIELDS = {
  name: { type: "string", min: 2, maxLength: 120 },
  address: { type: "string", maxLength: 240 },
  city: { type: "string", maxLength: 80 },
  type: { type: "string", maxLength: 60 },
  phone: { type: "string", maxLength: 40 },
  openHours: { type: "string", maxLength: 80 },
  // The schema constrains rating to 0-5 with one decimal place; validating it
  // here turns a bad value into a 422 instead of a 23514 from the database.
  rating: { type: "number", min: 0, max: 5 },
  queueEnabled: { type: "boolean" },
};

router.get("/facilities", ctrl.listFacilitiesAdmin);

router.post(
  "/facilities",
  validate({ ...FACILITY_FIELDS, name: { ...FACILITY_FIELDS.name, required: true },
             address: { ...FACILITY_FIELDS.address, required: true },
             city: { ...FACILITY_FIELDS.city, required: true } }),
  ctrl.createFacility,
);

// Update. The whole set is optional, so a caller can rename without resending
// the address. `updateByAdmin` applies its own allow-list as well; two layers,
// because validation says "is this well formed" and the allow-list says "may
// this be written".
router.patch(
  "/facilities/:id",
  validate({ id: { type: "string", minLength: 1, maxLength: 64 } }, "params"),
  validate(FACILITY_FIELDS),
  ctrl.updateFacility,
);

/* ---------------- services ---------------- */
router.get("/services", ctrl.listServicesAdmin);

/* ---------------- patients ---------------- */
router.get("/patients", ctrl.listPatients);

/* ---------------- notification audit log ---------------- */
router.get("/notifications", ctrl.notificationLog);

export default router;
