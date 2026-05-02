import { Dendri } from "./dendri";
import { util } from "./util";

(<any>window).dendri = {
	Dendri,
	util,
};
/** @deprecated Should use dendri namespace */
(<any>window).Dendri = Dendri;
