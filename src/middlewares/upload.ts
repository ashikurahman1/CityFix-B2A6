import multer from "multer";
import { ApiError } from "../utils/ApiError";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

/** Memory storage only: serverless file systems are read-only and ephemeral. */
export const uploadAttachments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, "Unsupported file type", [{ path: "files", message: "Allowed: JPEG, PNG, WEBP, PDF" }]));
  },
}).array("files", 3);
