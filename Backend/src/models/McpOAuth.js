import mongoose from 'mongoose';
const {Schema}=mongoose;
const clientSchema=new Schema({clientId:{type:String,required:true,unique:true},metadata:{type:Schema.Types.Mixed,required:true},sealedSecret:{type:String,select:false}},{timestamps:true});
const requestSchema=new Schema({requestHash:{type:String,required:true,unique:true},clientId:{type:String,required:true},redirectUri:String,state:String,scopes:[String],codeChallenge:String,resource:String,status:{type:String,enum:['pending','approved','denied','exchanged'],default:'pending'},codeHash:{type:String,select:false},codeExpiresAt:Date,keyId:{type:Schema.Types.ObjectId,ref:'McpAccessKey'},expiresAt:{type:Date,required:true}},{timestamps:true});
requestSchema.index({expiresAt:1},{expireAfterSeconds:0});requestSchema.index({codeHash:1},{sparse:true});
const accessSchema=new Schema({tokenHash:{type:String,required:true,unique:true,select:false},keyId:{type:Schema.Types.ObjectId,ref:'McpAccessKey',required:true},expiresAt:{type:Date,required:true}},{timestamps:true});accessSchema.index({expiresAt:1},{expireAfterSeconds:0});
export const McpOAuthClient=mongoose.model('McpOAuthClient',clientSchema);
export const McpOAuthRequest=mongoose.model('McpOAuthRequest',requestSchema);
export const McpOAuthToken=mongoose.model('McpOAuthToken',accessSchema);
