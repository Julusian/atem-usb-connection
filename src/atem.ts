import { EventEmitter } from 'events'
import { AtemState } from 'atem-connection/dist/state'
import { AtemUSBSocket } from './atem-usb'
import { ISerializableCommand, IDeserializedCommand } from 'atem-connection/dist/commands/CommandBase'
import * as Commands from 'atem-connection/dist/commands'
import * as DataTransferCommands from 'atem-connection/dist/commands/DataTransfer'
import { MediaPlayer, MediaPlayerSource } from 'atem-connection/dist/state/media'
import { MultiViewerSourceState } from 'atem-connection/dist/state/settings'
import {
	DipTransitionSettings,
	DVETransitionSettings,
	MixTransitionSettings,
	StingerTransitionSettings,
	SuperSourceBox,
	TransitionProperties,
	WipeTransitionSettings,
	SuperSourceProperties,
	SuperSourceBorder
} from 'atem-connection/dist/state/video'
import * as USK from 'atem-connection/dist/state/video/upstreamKeyers'
import { InputChannel } from 'atem-connection/dist/state/input'
import { DownstreamKeyerGeneral, DownstreamKeyerMask } from 'atem-connection/dist/state/video/downstreamKeyers'
import * as DT from 'atem-connection/dist/dataTransfer'
import { Util } from 'atem-connection/dist/lib/atemUtil'
import * as Enums from 'atem-connection/dist/enums'
import { AudioChannel, AudioMasterChannel } from 'atem-connection/dist/state/audio'
import { listVisibleInputs } from 'atem-connection/dist/lib/tally'

export interface AtemOptions {
	address?: string,
	port?: number,
	debug?: boolean,
	disableMultithreaded?: boolean

	externalLog?: (...args: any[]) => void
}

interface SentCommand {
	command: ISerializableCommand
	resolve: () => void
	reject: () => void
}

export enum AtemConnectionStatus {
	CLOSED,
	CONNECTING,
	CONNECTED
}

export const DEFAULT_PORT = 9910

export class BasicAtem extends EventEmitter {
	private readonly socket: AtemUSBSocket
	protected readonly dataTransferManager: DT.DataTransferManager
	private readonly _log: (...args: any[]) => void
	private _state: AtemState | undefined
	private _sentQueue: {[packetId: string]: SentCommand } = {}
	private _status: AtemConnectionStatus

	public on!: ((event: 'error', listener: (message: any) => void) => this) &
		((event: 'connected', listener: () => void) => this) &
		((event: 'disconnected', listener: () => void) => this) &
		((event: 'stateChanged', listener: (state: AtemState, paths: string[]) => void) => this) &
		((event: 'receivedCommands', listener: (cmds: IDeserializedCommand[]) => void) => this)

	public emit!: ((event: 'error', message: any) => boolean) &
		((event: 'connected') => boolean) &
		((event: 'disconnected') => boolean) &
		((event: 'stateChanged', state: AtemState, paths: string[]) => boolean) &
		((event: 'receivedCommands', cmds: IDeserializedCommand[]) => boolean)

	constructor (options?: AtemOptions) {
		super()
		this._log = (options && options.externalLog) || ((...args: any[]) => { console.log(...args) })

		this._state = new AtemState()
		this._status = AtemConnectionStatus.CLOSED
		this.socket = new AtemUSBSocket({
			debug: (options || {}).debug || false,
			log: this._log,
			address: (options || {}).address || '',
			port: (options || {}).port || DEFAULT_PORT,
			disableMultithreaded: (options || {}).disableMultithreaded || false
		})
		this.dataTransferManager = new DT.DataTransferManager()

		this.socket.on('commandsReceived', commands => {
			this.emit('receivedCommands', commands)
			this._mutateState(commands)
		})
		this.socket.on('commandsAck', trackingIds => this._resolveCommands(trackingIds))
		this.socket.on('error', e => this.emit('error', e))
		this.socket.on('disconnect', () => {
			this._status = AtemConnectionStatus.CLOSED
			this.dataTransferManager.stopCommandSending()
			this._rejectAllCommands()
			this.emit('disconnected')
			this._state = undefined
		})
	}

	private _onInitComplete () {
		this.dataTransferManager.startCommandSending(cmds => this.sendCommands(cmds))
		this.emit('connected')
	}

	get status (): AtemConnectionStatus {
		return this._status
	}

	get state (): Readonly<AtemState> | undefined {
		return this._state
	}

	public connect (address: string, port?: number) {
		return this.socket.connect(address, port)
	}

	public disconnect (): Promise<void> {
		return this.socket.disconnect()
	}

	public destroy (): Promise<void> {
		return this.socket.destroy()
	}

	private sendCommands (commands: ISerializableCommand[]): Array<Promise<void>> {
		const commands2 = commands.map(cmd => ({
			rawCommand: cmd,
			trackingId: this.socket.nextCommandTrackingId
		}))

		const sendPromise = this.socket.sendCommands(commands2)

		return commands2.map(async cmd => {
			await sendPromise
			return new Promise<void>((resolve, reject) => {
				this._sentQueue[cmd.trackingId] = {
					command: cmd.rawCommand,
					resolve,
					reject
				}
			})
		})
	}

	public sendCommand (command: ISerializableCommand): Promise<void> {
		return this.sendCommands([command])[0]
	}

	private _mutateState (commands: IDeserializedCommand[]) {
		// Is this the start of a new connection?
		if (commands.find(cmd => cmd.constructor.name === Commands.VersionCommand.name)) {
			// On start of connection, create a new state object
			this._state = new AtemState()
			this._status = AtemConnectionStatus.CONNECTING
		}

		const allChangedPaths: string[] = []

		const state = this._state
		commands.forEach(command => {
			if (state) {
				try {
					const changePaths = command.applyToState(state)
					if (!Array.isArray(changePaths)) {
						allChangedPaths.push(changePaths)
					} else {
						allChangedPaths.push(...changePaths)
					}
				} catch (e) {
					// TODO - should we error or warn on this?
					this.emit('error', `MutateState failed: ${e}. Command: ${command.constructor.name} ${JSON.stringify(command)}`)
				}
			}

			for (const commandName in DataTransferCommands) {
				if (command.constructor.name === commandName) {
					this.dataTransferManager.handleCommand(command)
				}
			}
		})

		const initComplete = commands.find(cmd => cmd.constructor.name === Commands.InitCompleteCommand.name)
		if (initComplete) {
			this._status = AtemConnectionStatus.CONNECTED
			this._onInitComplete()
		} else if (state && this._status === AtemConnectionStatus.CONNECTED && allChangedPaths.length > 0) {
			this.emit('stateChanged', state, allChangedPaths)
		}
	}

	private _resolveCommands (trackingIds: number[]) {
		trackingIds.forEach(trackingId => {
			const sent = this._sentQueue[trackingId]
			if (sent) {
				sent.resolve()
				delete this._sentQueue[trackingId]
			}
		})
	}

	private _rejectAllCommands () {
		// Take a copy in case the promises cause more mutations
		const sentQueue = this._sentQueue
		this._sentQueue = {}

		Object.values(sentQueue).forEach(sent => sent.reject())
	}
}

export class Atem extends BasicAtem {
	constructor (options?: AtemOptions) {
		super(options)
	}

	public changeProgramInput (input: number, me: number = 0) {
		const command = new Commands.ProgramInputCommand(me, input)
		return this.sendCommand(command)
	}

	public changePreviewInput (input: number, me: number = 0) {
		const command = new Commands.PreviewInputCommand(me, input)
		return this.sendCommand(command)
	}

	public cut (me: number = 0) {
		const command = new Commands.CutCommand(me)
		return this.sendCommand(command)
	}

	public autoTransition (me: number = 0) {
		const command = new Commands.AutoTransitionCommand(me)
		return this.sendCommand(command)
	}

	public fadeToBlack (me: number = 0) {
		const command = new Commands.FadeToBlackAutoCommand(me)
		return this.sendCommand(command)
	}

	public setFadeToBlackRate (rate: number, me: number = 0) {
		const command = new Commands.FadeToBlackRateCommand(me, rate)
		return this.sendCommand(command)
	}

	public autoDownstreamKey (key: number = 0, isTowardsOnAir?: boolean) {
		const command = new Commands.DownstreamKeyAutoCommand(key)
		command.updateProps({ isTowardsOnAir })
		return this.sendCommand(command)
	}

	public setDipTransitionSettings (newProps: Partial<DipTransitionSettings>, me: number = 0) {
		const command = new Commands.TransitionDipCommand(me)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setDVETransitionSettings (newProps: Partial<DVETransitionSettings>, me: number = 0) {
		const command = new Commands.TransitionDVECommand(me)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setMixTransitionSettings (newProps: Pick<MixTransitionSettings, 'rate'>, me: number = 0) {
		const command = new Commands.TransitionMixCommand(me, newProps.rate)
		return this.sendCommand(command)
	}

	public setTransitionPosition (position: number, me: number = 0) {
		const command = new Commands.TransitionPositionCommand(me, position)
		return this.sendCommand(command)
	}

	public previewTransition (on: boolean, me: number = 0) {
		const command = new Commands.PreviewTransitionCommand(me, on)
		return this.sendCommand(command)
	}

	public setTransitionStyle (newProps: Partial<TransitionProperties>, me: number = 0) {
		const command = new Commands.TransitionPropertiesCommand(me)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setStingerTransitionSettings (newProps: Partial<StingerTransitionSettings>, me: number = 0) {
		const command = new Commands.TransitionStingerCommand(me)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setWipeTransitionSettings (newProps: Partial<WipeTransitionSettings>, me: number = 0) {
		const command = new Commands.TransitionWipeCommand(me)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setAuxSource (source: number, bus: number = 0) {
		const command = new Commands.AuxSourceCommand(bus, source)
		return this.sendCommand(command)
	}

	public setDownstreamKeyTie (tie: boolean, key: number = 0) {
		const command = new Commands.DownstreamKeyTieCommand(key, tie)
		return this.sendCommand(command)
	}

	public setDownstreamKeyOnAir (onAir: boolean, key: number = 0) {
		const command = new Commands.DownstreamKeyOnAirCommand(key, onAir)
		return this.sendCommand(command)
	}

	public setDownstreamKeyCutSource (input: number, key: number = 0) {
		const command = new Commands.DownstreamKeyCutSourceCommand(key, input)
		return this.sendCommand(command)
	}

	public setDownstreamKeyFillSource (input: number, key: number = 0) {
		const command = new Commands.DownstreamKeyFillSourceCommand(key, input)
		return this.sendCommand(command)
	}

	public setDownstreamKeyGeneralProperties (props: Partial<DownstreamKeyerGeneral>, key: number = 0) {
		const command = new Commands.DownstreamKeyGeneralCommand(key)
		command.updateProps(props)
		return this.sendCommand(command)
	}

	public setDownstreamKeyMaskSettings (props: Partial<DownstreamKeyerMask>, key: number = 0) {
		const command = new Commands.DownstreamKeyMaskCommand(key)
		command.updateProps(props)
		return this.sendCommand(command)
	}

	public setDownstreamKeyRate (rate: number, key: number = 0) {
		const command = new Commands.DownstreamKeyRateCommand(key, rate)
		return this.sendCommand(command)
	}

	public macroContinue () {
		const command = new Commands.MacroActionCommand(0, Enums.MacroAction.Continue)
		return this.sendCommand(command)
	}

	public macroDelete (index = 0) {
		const command = new Commands.MacroActionCommand(index, Enums.MacroAction.Delete)
		return this.sendCommand(command)
	}

	public macroInsertUserWait () {
		const command = new Commands.MacroActionCommand(0, Enums.MacroAction.InsertUserWait)
		return this.sendCommand(command)
	}

	public macroRun (index: number = 0) {
		const command = new Commands.MacroActionCommand(index, Enums.MacroAction.Run)
		return this.sendCommand(command)
	}

	public macroStop () {
		const command = new Commands.MacroActionCommand(0, Enums.MacroAction.Stop)
		return this.sendCommand(command)
	}

	public macroStopRecord () {
		const command = new Commands.MacroActionCommand(0, Enums.MacroAction.StopRecord)
		return this.sendCommand(command)
	}

	public setMultiViewerSource (newProps: Partial<MultiViewerSourceState>, mv = 0) {
		const command = new Commands.MultiViewerSourceCommand(mv)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setMediaPlayerSettings (newProps: Partial<MediaPlayer>, player: number = 0) {
		const command = new Commands.MediaPlayerStatusCommand(player)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setMediaPlayerSource (newProps: Partial<MediaPlayerSource>, player: number = 0) {
		const command = new Commands.MediaPlayerSourceCommand(player)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setMediaClip (index: number, name: string, frames: number = 1) {
		const command = new Commands.MediaPoolSetClipCommand({ index, name, frames })
		return this.sendCommand(command)
	}

	public clearMediaPoolClip (clipId: number) {
		const command = new Commands.MediaPoolClearClipCommand(clipId)
		return this.sendCommand(command)
	}

	public clearMediaPoolStill (stillId: number) {
		const command = new Commands.MediaPoolClearStillCommand(stillId)
		return this.sendCommand(command)
	}

	public setSuperSourceBoxSettings (newProps: Partial<SuperSourceBox>, box: number = 0, ssrcId: number = 0) {
		const command = new Commands.SuperSourceBoxParametersCommand(ssrcId, box)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setSuperSourceProperties (newProps: Partial<SuperSourceProperties>, ssrcId: number = 0) {
		if (this.state && this.state.info.apiVersion >= Enums.ProtocolVersion.V8_0) {
			const command = new Commands.SuperSourcePropertiesV8Command(ssrcId)
			command.updateProps(newProps)
			return this.sendCommand(command)
		} else {
			const command = new Commands.SuperSourcePropertiesCommand()
			command.updateProps(newProps)
			return this.sendCommand(command)
		}
	}

	public setSuperSourceBorder (newProps: Partial<SuperSourceBorder>, ssrcId: number = 0) {
		if (this.state && this.state.info.apiVersion >= Enums.ProtocolVersion.V8_0) {
			const command = new Commands.SuperSourceBorderCommand(ssrcId)
			command.updateProps(newProps)
			return this.sendCommand(command)
		} else {
			const command = new Commands.SuperSourcePropertiesCommand()
			command.updateProps(newProps)
			return this.sendCommand(command)
		}
	}

	public setInputSettings (newProps: Partial<InputChannel>, input: number = 0) {
		const command = new Commands.InputPropertiesCommand(input)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerChromaSettings (newProps: Partial<USK.UpstreamKeyerChromaSettings>, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyChromaCommand(me, keyer)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerCutSource (cutSource: number, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyCutSourceSetCommand(me, keyer, cutSource)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerFillSource (fillSource: number, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyFillSourceSetCommand(me, keyer, fillSource)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerDVESettings (newProps: Partial<USK.UpstreamKeyerDVESettings>, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyDVECommand(me, keyer)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerLumaSettings (newProps: Partial<USK.UpstreamKeyerLumaSettings>, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyLumaCommand(me, keyer)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerMaskSettings (newProps: Partial<USK.UpstreamKeyerMaskSettings>, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyMaskSetCommand(me, keyer)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerPatternSettings (newProps: Partial<USK.UpstreamKeyerPatternSettings>, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyPatternCommand(me, keyer)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerOnAir (onAir: boolean, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyOnAirCommand(me, keyer, onAir)
		return this.sendCommand(command)
	}

	public setUpstreamKeyerType (newProps: Partial<USK.UpstreamKeyerTypeSettings>, me: number = 0, keyer: number = 0) {
		const command = new Commands.MixEffectKeyTypeSetCommand(me, keyer)
		command.updateProps(newProps)
		return this.sendCommand(command)
	}

	public uploadStill (index: number, data: Buffer, name: string, description: string) {
		if (!this.state) return Promise.reject()
		const resolution = Util.getResolution(this.state.settings.videoMode)
		return this.dataTransferManager.uploadStill(
			index,
			Util.convertRGBAToYUV422(resolution[0], resolution[1], data),
			name,
			description
		)
	}

	public uploadClip (index: number, frames: Array<Buffer>, name: string) {
		if (!this.state) return Promise.reject()
		const resolution = Util.getResolution(this.state.settings.videoMode)
		const data: Array<Buffer> = []
		for (const frame of frames) {
			data.push(Util.convertRGBAToYUV422(resolution[0], resolution[1], frame))
		}
		return this.dataTransferManager.uploadClip(
			index,
			data,
			name
		)
	}

	public uploadAudio (index: number, data: Buffer, name: string) {
		return this.dataTransferManager.uploadAudio(
			index,
			Util.convertWAVToRaw(data),
			name
		)
	}

	public setAudioMixerInputMixOption (index: number, mixOption: Enums.AudioMixOption) {
		const command = new Commands.AudioMixerInputCommand(index)
		command.updateProps({ mixOption })
		return this.sendCommand(command)
	}

	public setAudioMixerInputGain (index: number, gain: number) {
		const command = new Commands.AudioMixerInputCommand(index)
		command.updateProps({ gain })
		return this.sendCommand(command)
	}

	public setAudioMixerInputBalance (index: number, balance: number) {
		const command = new Commands.AudioMixerInputCommand(index)
		command.updateProps({ balance })
		return this.sendCommand(command)
	}

	public setAudioMixerInputProps (index: number, props: Partial<AudioChannel>) {
		const command = new Commands.AudioMixerInputCommand(index)
		command.updateProps(props)
		return this.sendCommand(command)
	}

	public setAudioMixerMasterGain (gain: number) {
		const command = new Commands.AudioMixerMasterCommand()
		command.updateProps({ gain })
		return this.sendCommand(command)
	}

	public setAudioMixerMasterProps (props: Partial<AudioMasterChannel>) {
		const command = new Commands.AudioMixerMasterCommand()
		command.updateProps(props)
		return this.sendCommand(command)
	}

	public listVisibleInputs (mode: 'program' | 'preview', me = 0): number[] {
		if (this.state) {
			return listVisibleInputs(mode, this.state, me)
		} else {
			return []
		}
	}
}
