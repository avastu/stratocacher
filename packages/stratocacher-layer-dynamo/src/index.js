import Q from "q";
import lzutf8 from "lzutf8";
import {DynamoDB} from "aws-sdk";
import {Layer, events} from "stratocacher";

var CLIENTS = {}, DEFAULT_TIMEOUT = 3000;

class Client {
	constructor(awsConfig) {
		const ddbClient = new DynamoDB(awsConfig);
		this.getItem = Q.nbind(ddbClient.getItem, ddbClient);
		this.putItem = Q.nbind(ddbClient.putItem, ddbClient);
	}
}

function emitError(message) {
	events.emit("error", {
		name: "LayerDynamo",
		error: new Error(message),
	});
}
/*
	DynamoDB Caching Layer.
	Uses AWS-SDK Dynamo client:
	https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html

	Configuration notes:

	1. You must provide a tableName parameter that corresponds to the name
	of your DynamoDB table.

	2. You must configure your Dynamo table to respect the ttl field,
	otherwise Dynamo will not evict expired entries. See:
	https://docs.amazonaws.cn/en_us/amazondynamodb/latest/developerguide/time-to-live-ttl-how-to.html

	Once populated, your Dynamo table will look like this:

	Field:  Type:     Description:
	c       Boolean   Compression flag
	i       Boolean   Invalidation flag
	key     String    DynamoDB Key
	t       Number    Time created
	ttl     Number    Time to live
	v       String    Value

	Config options:
	tableName      : The name of your DynamoDB table.
	awsConfig      : aws-sdk config.
	compress       : Compress values (default = false)
	requestTimeout : Timeout for requests to Dynamo (default = 3s)
*/
export default class LayerDynamo extends Layer {

	constructor(options) {
		super(options);
		if (!this.opt.tableName) {
			emitError("Must provide tableName");
		}
		if (!this.opt.awsConfig) {
			emitError("Must provide awsConfig");
		}
	}
	getClient() {
		if (!CLIENTS[this.cid]) {
			CLIENTS[this.cid] = new Client(this.opt.awsConfig);
		}
		return CLIENTS[this.cid];
	}

	get() {
		return this.getClient()
			.getItem(this.makeDDBGetParams(this.key))
			.timeout(this.opt.requestTimeout || DEFAULT_TIMEOUT)
			.then((response) => {

				if (response && response.Item) {

					const {Item} = response;
					const v = this.parseValue(Item);
					this.load({
						key: Item.key.S,
						v: v,
						t: Number(Item.t.N),
						i: Item.i.BOOL,
					});
				}
			});
	}

	set(val) {
		return this.getClient()
			.putItem(this.makeDDBPutParams(this.key, val))
			.timeout(this.opt.requestTimeout || DEFAULT_TIMEOUT);
	}

	makeDDBGetParams(key) {
		return {
			Key: {
				key: {
					S: String(key),
				},
			},
			TableName: this.opt.tableName,
		};
	}

	makeDDBPutParams(key, val) {

		const {v, t, i} = this.dump(val);
		const TableName = this.opt.tableName;
		const Item = {
			v: this.makeValue(v),
			key: {
				S: String(key),
			},
			t: {
				N: String(t), //Dynamo requires numbers be sent as strings
			},
			i: {
				BOOL: Boolean(i),
			},
			c: {
				BOOL: Boolean(this.opt.compress),
			},
		}

		if (this.ttl) {
			Item.ttl = {
				N: String(Math.floor((this.ttl + t) / 1000)),
			}
		}

		return {Item, TableName};
	}

	/*
		returns a typed value: {<type toke>: value},
		If opt.compress is true, compresses value and
		uses type binary, otherwise stores val as a string.
	*/
	makeValue(v) {
		v = JSON.stringify(v);

		const typedV = {};

		if (this.opt.compress) {
			typedV.B = lzutf8.compress(v); //B token means "binary"
		}
		else {
			typedV.S = v; //S token means "string"
		}

		return typedV;
	}

	parseValue({v, c}) {

		if (c && c.BOOL) { // c flag tells us this value is compressed
			if (!v.B) {
				// v.B had better exist, otherwise something went wrong with set.
				emitError("Compression flag (c) was set, but v.B is undefined for key: " + this.key);
				return undefined;
			}
			v = lzutf8.decompress(v.B);
		} else {
			if (!v.S) {
				emitError("Compression flag (c) was not set, but v.S is undefined for key: " + this.key);
				return undefined;
			}
			v = v.S;
		}

		return JSON.parse(v);
	}

}
