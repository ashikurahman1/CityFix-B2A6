import type { Request, Response } from "express";
import { currentUser } from "../../middlewares/auth";
import { clientIp } from "../../utils/audit";
import { sendResponse } from "../../utils/sendResponse";
import * as service from "./complaint.service";

const id = (req: Request) => req.params.id as string;

export async function create(req: Request, res: Response) {
  const data = await service.createComplaint(currentUser(req), req.body, clientIp(req));
  sendResponse(res, { statusCode: 201, message: "Complaint filed successfully", data });
}

export async function list(req: Request, res: Response) {
  const { items, meta } = await service.listComplaints(currentUser(req), res.locals.query);
  sendResponse(res, { message: "Complaints retrieved successfully", data: items, meta });
}

export async function track(req: Request, res: Response) {
  const data = await service.trackComplaint(req.params.trackingCode as string);
  sendResponse(res, { message: "Tracking information retrieved successfully", data });
}

export async function getOne(req: Request, res: Response) {
  const data = await service.getComplaint(currentUser(req), id(req));
  sendResponse(res, { message: "Complaint retrieved successfully", data });
}

export async function timeline(req: Request, res: Response) {
  const data = await service.getTimeline(currentUser(req), id(req));
  sendResponse(res, { message: "Timeline retrieved successfully", data });
}

export async function update(req: Request, res: Response) {
  const data = await service.updateComplaint(currentUser(req), id(req), req.body, clientIp(req));
  sendResponse(res, { message: "Complaint updated successfully", data });
}

export async function remove(req: Request, res: Response) {
  await service.deleteComplaint(currentUser(req), id(req), clientIp(req));
  sendResponse(res, { message: "Complaint deleted successfully" });
}

export async function assign(req: Request, res: Response) {
  const data = await service.assignComplaint(currentUser(req), id(req), req.body, clientIp(req));
  sendResponse(res, { message: "Complaint assigned successfully", data });
}

export async function claim(req: Request, res: Response) {
  const data = await service.claimComplaint(currentUser(req), id(req), clientIp(req));
  sendResponse(res, { message: "Complaint claimed successfully", data });
}

export async function updateStatus(req: Request, res: Response) {
  const data = await service.updateStatus(currentUser(req), id(req), req.body, clientIp(req));
  sendResponse(res, { message: `Complaint marked as ${data.status}`, data });
}

export async function cancel(req: Request, res: Response) {
  const data = await service.cancelComplaint(currentUser(req), id(req), req.body.reason, clientIp(req));
  sendResponse(res, { message: "Complaint cancelled successfully", data });
}

export async function reopen(req: Request, res: Response) {
  const data = await service.reopenComplaint(currentUser(req), id(req), req.body.reason, clientIp(req));
  sendResponse(res, { message: "Complaint reopened successfully", data });
}

export async function feedback(req: Request, res: Response) {
  const data = await service.submitFeedback(currentUser(req), id(req), req.body, clientIp(req));
  sendResponse(res, { statusCode: 201, message: "Thank you for your feedback. Complaint closed", data });
}

export async function addComment(req: Request, res: Response) {
  const data = await service.addComment(currentUser(req), id(req), req.body);
  sendResponse(res, { statusCode: 201, message: "Comment added successfully", data });
}

export async function listComments(req: Request, res: Response) {
  const data = await service.listComments(currentUser(req), id(req));
  sendResponse(res, { message: "Comments retrieved successfully", data });
}

export async function addAttachments(req: Request, res: Response) {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const data = await service.addAttachments(currentUser(req), id(req), files);
  sendResponse(res, { statusCode: 201, message: "Files uploaded successfully", data });
}
