//#region src/transport.ts
/**
* Assert a reply target's declared type agrees with the id it carries.
*
* Feishu infers the receive-id type from the id's prefix, so a target whose
* declared type disagrees with its value is routed as the *prefix* says and the
* declared type is silently ignored. Checking here turns that into a named
* error at the call site instead of a message delivered to the wrong place.
* @param target - the target about to be used.
* @throws {Error} when the value's prefix contradicts the declared type.
*/
function assertReplyTarget(target) {
	const inferred = target.receiveId.startsWith("oc_") ? "chat_id" : target.receiveId.startsWith("ou_") ? "open_id" : void 0;
	if (inferred !== void 0 && inferred !== target.receiveIdType) throw new Error(`dsh-im reply target declares ${target.receiveIdType} but its value ${JSON.stringify(target.receiveId)} is a ${inferred}`);
}
//#endregion
export { assertReplyTarget };

//# sourceMappingURL=transport.js.map