import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";
import { ApiError } from "../utils/ApiError";

const configured = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

if (configured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export interface UploadedFile {
  url: string;
  publicId: string;
}

/** Streams an in-memory buffer to Cloudinary (no local disk - serverless safe). */
export function uploadBuffer(buffer: Buffer, folder: string): Promise<UploadedFile> {
  if (!configured) {
    throw new ApiError(503, "File storage is not configured (Cloudinary credentials missing)");
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder, resource_type: "auto" }, (error, result) => {
      if (error || !result) {
        reject(new ApiError(502, "File upload failed", [{ message: error?.message ?? "Unknown upload error" }]));
        return;
      }
      resolve({ url: result.secure_url, publicId: result.public_id });
    });
    stream.end(buffer);
  });
}
