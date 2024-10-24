import { concatBytes } from "@noble/curves/abstract/utils";
import { p256 as secp256r1 } from "@noble/curves/p256";
import { ECDSASigValue } from "@peculiar/asn1-ecc";
import { AsnParser } from "@peculiar/asn1-schema";
import {
  ArraySignatureType,
  BigNumberish,
  CairoCustomEnum,
  CallData,
  Uint256,
  hash,
  shortString,
  uint256,
} from "starknet";
import { buf2hex, hex2buf } from "./bytes";
import { KeyPair, SignerType, signerTypeToCustomEnum } from "./signers";
import type { WebauthnAttestation } from "./webauthnAttestation";

import { Message, sha256 as jssha256 } from "js-sha256";

function sha256(message: Message): Uint8Array {
  return hex2buf(jssha256(message));
}

const normalizeTransactionHash = (transactionHash: string) => transactionHash.replace(/^0x/, "").padStart(64, "0");
const findInArray = (dataToFind: Uint8Array, arrayToIterate: Uint8Array) => {
  return arrayToIterate.findIndex((element, i) => {
    const slice = arrayToIterate.slice(i, i + dataToFind.length);
    return dataToFind.toString() === slice.toString();
  });
};
export type NormalizedSecpSignature = { r: bigint; s: bigint; yParity: boolean };

export function normalizeSecpR1Signature(signature: {
  r: bigint;
  s: bigint;
  recovery: number;
}): NormalizedSecpSignature {
  return normalizeSecpSignature(secp256r1, signature);
}

export function normalizeSecpSignature(
  curve: typeof secp256r1,
  signature: { r: bigint; s: bigint; recovery: number },
): NormalizedSecpSignature {
  let s = signature.s;
  let yParity = signature.recovery !== 0;
  if (s > curve.CURVE.n / 2n) {
    s = curve.CURVE.n - s;
    yParity = !yParity;
  }
  return { r: signature.r, s, yParity };
}

const toCharArray = (value: string) => CallData.compile(value.split("").map(shortString.encodeShortString));

interface WebauthnSignature {
  cross_origin: boolean;
  client_data_json_outro: BigNumberish[];
  flags: number;
  sign_count: number;
  ec_signature: { r: Uint256; s: Uint256; y_parity: boolean };
  sha256_implementation: CairoCustomEnum;
}

export class WebauthnOwner extends KeyPair {
  attestation: WebauthnAttestation;
  requestSignature: (
    attestation: WebauthnAttestation,
    challenge: Uint8Array,
  ) => Promise<AuthenticatorAssertionResponse>;
  rpIdHash: Uint256;
  crossOrigin = false;

  constructor(
    attestation: WebauthnAttestation,
    requestSignature: (
      attestation: WebauthnAttestation,
      challenge: Uint8Array,
    ) => Promise<AuthenticatorAssertionResponse>,
  ) {
    super();
    this.attestation = attestation;
    this.requestSignature = requestSignature;
    this.rpIdHash = uint256.bnToUint256(buf2hex(sha256(attestation.rpId)));
  }

  public get publicKey() {
    return BigInt(buf2hex(this.attestation.pubKey));
  }

  public get guid(): bigint {
    const rpIdHashAsU256 = this.rpIdHash;
    const publicKeyAsU256 = uint256.bnToUint256(this.publicKey);
    const originBytes = toCharArray(this.attestation.origin);
    const elements = [
      shortString.encodeShortString("Webauthn Signer"),
      originBytes.length,
      ...originBytes,
      rpIdHashAsU256.low,
      rpIdHashAsU256.high,
      publicKeyAsU256.low,
      publicKeyAsU256.high,
    ];
    return BigInt(hash.computePoseidonHashOnElements(elements));
  }

  public get storedValue(): bigint {
    return this.guid;
  }

  public get signer(): CairoCustomEnum {
    return signerTypeToCustomEnum(SignerType.Webauthn, {
      origin: toCharArray(this.attestation.origin),
      rp_id_hash: this.rpIdHash,
      pubkey: uint256.bnToUint256(this.publicKey),
    });
  }

  public async signRaw(messageHash: string): Promise<ArraySignatureType> {
    const challenge = hex2buf(`${normalizeTransactionHash(messageHash)}00`);
    const assertionResponse = await this.requestSignature(this.attestation, challenge);
    const authenticatorData = new Uint8Array(assertionResponse.authenticatorData);
    const clientDataJson = new Uint8Array(assertionResponse.clientDataJSON);
    const flags = authenticatorData[32];
    const signCount = Number(BigInt(buf2hex(authenticatorData.slice(33, 37))));
    console.log("clientDataJson", new TextDecoder().decode(clientDataJson));
    console.log("flags", flags);
    console.log("signCount", signCount);

    const crossOriginText = new TextEncoder().encode(`"crossOrigin":${this.crossOrigin}`);
    const crossOriginIndex = findInArray(crossOriginText, clientDataJson);
    let clientDataJsonOutro = clientDataJson.slice(crossOriginIndex + crossOriginText.length);
    if (clientDataJsonOutro.length == 1) {
      clientDataJsonOutro = new Uint8Array();
    }

    let { r, s } = parseASN1Signature(assertionResponse.signature);
    let yParity = getYParity(getMessageHash(authenticatorData, clientDataJson), this.publicKey, r, s);

    const normalizedSignature = normalizeSecpR1Signature({ r, s, recovery: yParity ? 1 : 0 });
    r = normalizedSignature.r;
    s = normalizedSignature.s;
    yParity = normalizedSignature.yParity;

    const signature: WebauthnSignature = {
      cross_origin: this.crossOrigin,
      client_data_json_outro: Array.from(clientDataJsonOutro),
      flags,
      sign_count: signCount,
      ec_signature: {
        r: uint256.bnToUint256(r),
        s: uint256.bnToUint256(s),
        y_parity: yParity,
      },
      sha256_implementation: new CairoCustomEnum({
        Cairo0: {},
        Cairo1: undefined,
      }),
    };

    console.log("WebauthnOwner signed, signature is:", signature);
    return CallData.compile([
      signerTypeToCustomEnum(SignerType.Webauthn, { signer: this.signer.variant.Webauthn, signature }),
    ]);
  }
}

/**
 * In WebAuthn, EC2 signatures are wrapped in ASN.1 structure so we need to peel r and s apart.
 *
 * See https://www.w3.org/TR/webauthn-2/#sctn-signature-attestation-types
 */
const parseASN1Signature = (asn1Signature: BufferSource) => {
  const signature = AsnParser.parse(asn1Signature, ECDSASigValue);
  console.log("parseASN1Signature", signature);
  let r = new Uint8Array(signature.r);
  let s = new Uint8Array(signature.s);
  const shouldRemoveLeadingZero = (bytes: Uint8Array): boolean => bytes[0] === 0x0 && (bytes[1] & (1 << 7)) !== 0;
  if (shouldRemoveLeadingZero(r)) {
    r = r.slice(1);
  }
  if (shouldRemoveLeadingZero(s)) {
    s = s.slice(1);
  }
  return { r: BigInt(buf2hex(r)), s: BigInt(buf2hex(s)) };
};

const getMessageHash = (authenticatorData: Uint8Array, clientDataJson: Uint8Array) => {
  const clientDataHash = sha256(clientDataJson);
  const message = concatBytes(authenticatorData, clientDataHash);
  return sha256(message);
};

const getYParity = (messageHash: Uint8Array, pubkey: bigint, r: bigint, s: bigint) => {
  const signature = new secp256r1.Signature(r, s);

  const recoveredEven = signature.addRecoveryBit(0).recoverPublicKey(messageHash);
  if (pubkey === recoveredEven.x) {
    return false;
  }
  const recoveredOdd = signature.addRecoveryBit(1).recoverPublicKey(messageHash);
  if (pubkey === recoveredOdd.x) {
    return true;
  }
  throw new Error("Could not determine y_parity");
};
