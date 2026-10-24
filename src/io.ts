import { Server } from "socket.io";

export const io = new Server();

export const roomChannel = (roomId: string) => `room:${roomId}`;
export const userChannel = (userId: string) => `user:${userId}`;

export const emitToRoom = (roomId: string, event: string, payload: unknown) => io.to(roomChannel(roomId)).emit(event, payload);
