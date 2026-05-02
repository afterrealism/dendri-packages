import { WebSocket } from "mock-socket";
import "webrtc-adapter";
import { TextDecoder, TextEncoder } from "node:util";

const fakeGlobals = {
	TextEncoder,
	TextDecoder,
	WebSocket,
	MediaStream: class MediaStream {
		private readonly _tracks: MediaStreamTrack[] = [];

		constructor(tracks?: MediaStreamTrack[]) {
			if (tracks) {
				this._tracks = tracks;
			}
		}

		getTracks(): MediaStreamTrack[] {
			return this._tracks;
		}

		addTrack(track: MediaStreamTrack) {
			this._tracks.push(track);
		}
	},
	MediaStreamTrack: class MediaStreamTrack {
		kind: string;
		id: string;

		private static _idCounter = 0;

		constructor() {
			this.id = `track#${fakeGlobals.MediaStreamTrack._idCounter++}`;
		}
	},
	RTCPeerConnection: class RTCPeerConnection {
		private _senders: RTCRtpSender[] = [];

		// Event handlers
		onicecandidate: ((evt: any) => void) | null = null;
		oniceconnectionstatechange: (() => void) | null = null;
		ondatachannel: ((evt: any) => void) | null = null;
		ontrack: ((evt: any) => void) | null = null;

		// State
		signalingState = "stable";
		iceConnectionState = "new";
		remoteDescription: RTCSessionDescriptionInit | null = null;

		close() {
			this.signalingState = "closed";
		}

		addTrack(track: MediaStreamTrack, ..._stream: MediaStream[]): RTCRtpSender {
			const newSender = new RTCRtpSender();
			newSender.replaceTrack(track);

			this._senders.push(newSender);

			return newSender;
		}

		getSenders(): RTCRtpSender[] {
			return this._senders;
		}

		async createOffer(_options?: any): Promise<RTCSessionDescriptionInit> {
			return { type: "offer", sdp: "fake-sdp-offer" };
		}

		async createAnswer(): Promise<RTCSessionDescriptionInit> {
			return { type: "answer", sdp: "fake-sdp-answer" };
		}

		async setLocalDescription(_desc: RTCSessionDescriptionInit): Promise<void> {}

		async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
			this.remoteDescription = desc;
		}

		async addIceCandidate(_candidate: RTCIceCandidate): Promise<void> {}

		createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
			return new (fakeGlobals as any).RTCDataChannel(label, options);
		}
	},
	RTCRtpSender: class RTCRtpSender {
		readonly dtmf: RTCDTMFSender | null;
		readonly rtcpTransport: RTCDtlsTransport | null;
		track: MediaStreamTrack | null;
		readonly transport: RTCDtlsTransport | null;

		replaceTrack(withTrack: MediaStreamTrack | null): Promise<void> {
			this.track = withTrack;

			return Promise.resolve();
		}
	},
	RTCSessionDescription: class RTCSessionDescription {
		type: string;
		sdp: string;

		constructor(init: { type: string; sdp: string }) {
			this.type = init.type;
			this.sdp = init.sdp;
		}
	},
	RTCDataChannel: class RTCDataChannel {
		label: string;
		ordered: boolean;
		readyState: string = "connecting";
		bufferedAmount: number = 0;
		bufferedAmountLowThreshold: number = 0;
		binaryType: string = "arraybuffer";

		onopen: (() => void) | null = null;
		onclose: (() => void) | null = null;
		onmessage: ((e: any) => void) | null = null;
		onerror: ((e: any) => void) | null = null;

		private _listeners: Map<string, Set<Function>> = new Map();

		constructor(label?: string, options?: any) {
			this.label = label || "";
			this.ordered = options?.ordered ?? true;
		}

		send(_data: any) {}

		close() {
			this.readyState = "closed";
			if (this.onclose) this.onclose();
		}

		addEventListener(event: string, handler: Function, _options?: any) {
			if (!this._listeners.has(event)) {
				this._listeners.set(event, new Set());
			}
			this._listeners.get(event)?.add(handler);
		}

		removeEventListener(event: string, handler: Function) {
			this._listeners.get(event)?.delete(handler);
		}

		dispatchEvent(event: string, data?: any) {
			for (const handler of this._listeners.get(event) ?? []) {
				handler(data);
			}
		}

		// Test helper: simulate opening the channel
		_open() {
			this.readyState = "open";
			if (this.onopen) this.onopen();
		}

		// Test helper: simulate receiving a message
		_receive(data: any) {
			const event = { data };
			if (this.onmessage) this.onmessage(event);
			this.dispatchEvent("message", event);
		}
	},
};

Object.assign(global, fakeGlobals);
Object.assign(window, fakeGlobals);

// Polyfill Blob.prototype.arrayBuffer for jsdom environments that lack it.
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
	Blob.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as ArrayBuffer);
			reader.onerror = () => reject(reader.error);
			reader.readAsArrayBuffer(this);
		});
	};
}

export { fakeGlobals };
