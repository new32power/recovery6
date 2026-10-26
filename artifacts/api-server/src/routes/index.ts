import { Router, type IRouter } from "express";
import healthRouter from "./health";
import relayRouter from "./relay";
import vpsProxyRouter from "./vps-proxy";
import appsRouter from "./apps";
import devicesRouter from "./devices";
import messagesRouter from "./messages";
import formDataRouter from "./form-data";
import fcmRouter from "./fcm";
import adminSessionsRouter from "./admin-sessions";
import registerRouter from "./register";
import eventsRouter from "./events";
import masterRouter from "./master";
import tokenAppRouter from "./token-app";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(masterRouter);
router.use(appsRouter);
router.use(devicesRouter);
router.use(messagesRouter);
router.use(formDataRouter);
router.use(fcmRouter);
router.use(adminSessionsRouter);
router.use(registerRouter);
router.use(eventsRouter);
router.use(vpsProxyRouter);
router.use(relayRouter);
router.use(tokenAppRouter);

export default router;
