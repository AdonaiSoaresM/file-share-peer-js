import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input"; // Adjusted path
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card"; // Adjusted path
import { Label } from "./ui/label"; // Adjusted path
import { Progress } from "./ui/progress"; // Adjusted path
import { usePeerViewModel } from "../viewmodels/usePeerViewModel";
import { ConnectionStatus } from "../models/PeerData";
import { toast } from "sonner";
import { Toaster } from "./ui/sonner";
import "./MainView.css"; // Adjusted path

function MainView() {
    // Use the ViewModel hook
    const {
        myPeerId,
        connectionStatus,
        connectionMessage,
        connectedPeerId,
        receivedFiles,
        transferProgress,
        // lastReceivedMessage, // Not used in UI for now
        connect,
        disconnect,
        sendFile,
        downloadFile,
        // sendMessage // Not used in UI for now
    } = usePeerViewModel();

    // Local UI state
    const [targetPeerId, setTargetPeerId] = useState<string>("");
    const [selectedFile, setSelectedFile] = useState<File | null>(null);

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files && event.target.files[0]) {
            setSelectedFile(event.target.files[0]);
            console.log("View: Arquivo selecionado:", event.target.files[0].name);
        }
    };

    const handleSendFile = () => {
        sendFile(selectedFile);
    };

    const handleConnect = () => {
        connect(targetPeerId);
    };

    const handleShare = () => {
        if (!myPeerId) return;
        const baseUrl = window.location.origin + window.location.pathname;
        const shareUrl = `${baseUrl}?connect=${encodeURIComponent(myPeerId)}`;
        navigator.clipboard.writeText(shareUrl).then(() => {
            toast.success("Link copiado!", {
                description: "Compartilhe este link para que outro usuário se conecte automaticamente.",
            });
        }).catch(() => {
            toast.error("Erro ao copiar link.");
        });
    };

    // Auto-connect via query param on mount
    useEffect(() => {
        if (!myPeerId) return;
        const params = new URLSearchParams(window.location.search);
        const connectParam = params.get("connect");
        if (connectParam && (connectionStatus === ConnectionStatus.WAITING || connectionStatus === ConnectionStatus.DISCONNECTED)) {
            console.log("MainView: Auto-connecting to", connectParam);
            setTargetPeerId(connectParam);
            connect(connectParam);
        }
    }, [myPeerId, connectionStatus, connect]); // Runs when myPeerId becomes available or status changes

    const isConnected = connectionStatus === ConnectionStatus.CONNECTED;
    const isConnecting = connectionStatus === ConnectionStatus.CONNECTING;
    const isDisconnected = connectionStatus === ConnectionStatus.DISCONNECTED || connectionStatus === ConnectionStatus.WAITING || connectionStatus === ConnectionStatus.ERROR;

    // Determine connection status color
    const getStatusColor = () => {
        switch (connectionStatus) {
            case ConnectionStatus.CONNECTED:
                return "text-green-600";
            case ConnectionStatus.CONNECTING:
            case ConnectionStatus.WAITING:
                return "text-orange-600";
            case ConnectionStatus.DISCONNECTED:
            case ConnectionStatus.ERROR:
            default:
                return "text-red-600";
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-background p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>Compartilhamento P2P (MVVM)</CardTitle>
                    <CardDescription>Conecte-se a outro usuário para compartilhar arquivos via PeerJS.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Peer ID Section */}
                    <div>
                        <Label>Seu ID de Conexão:</Label>
                        <div className="flex space-x-2 mt-1">
                            <Input type="text" value={myPeerId || "Gerando ID..."} readOnly className="flex-1" />
                            <Button onClick={handleShare} disabled={!myPeerId} variant="secondary">
                                Compartilhar
                            </Button>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">Compartilhe este ID com quem você deseja se conectar.</p>
                    </div>

                    {/* Connection Section */}
                    <div className="space-y-2">
                        <Label htmlFor="target-id">ID do Destinatário:</Label>
                        <div className="flex space-x-2">
                            <Input
                                id="target-id"
                                type="text"
                                placeholder="Cole o ID aqui"
                                value={targetPeerId}
                                onChange={(e) => setTargetPeerId(e.target.value)}
                                disabled={isConnected || isConnecting}
                            />
                            {isDisconnected && (
                                <Button onClick={handleConnect} disabled={!targetPeerId || isConnecting}>
                                    {isConnecting ? "Conectando..." : "Conectar"}
                                </Button>
                            )}
                            {isConnected && (
                                <Button onClick={disconnect} variant="destructive">
                                    Desconectar
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Status Section */}
                    <div>
                        <Label>Status da Conexão:</Label>
                        <p className={`mt-1 font-medium ${getStatusColor()}`}>
                            {connectionStatus}
                            {connectedPeerId && ` com ${connectedPeerId}`}
                            {connectionMessage && ` (${connectionMessage})`}
                        </p>
                    </div>

                    {/* File Sharing Section - Visible only when connected */} 
                    {isConnected && (
                        <div className="border-t pt-4 mt-4 space-y-4">
                            {/* File Sending */}
                            <div>
                                <Label htmlFor="file-input">Selecionar Arquivo para Enviar:</Label>
                                <Input id="file-input" type="file" onChange={handleFileChange} className="mt-1" disabled={transferProgress > 0 && transferProgress < 100}/>
                                {selectedFile && (
                                    <div className="flex justify-between items-center mt-2">
                                        <p className="text-sm text-muted-foreground truncate pr-2" title={selectedFile.name}>{selectedFile.name}</p>
                                        <Button onClick={handleSendFile} size="sm" disabled={!selectedFile || (transferProgress > 0 && transferProgress < 100)}>
                                            {transferProgress > 0 && transferProgress < 100 ? `Enviando... ${transferProgress}%` : "Enviar Arquivo"}
                                        </Button>
                                    </div>
                                )}
                                {transferProgress > 0 && (
                                    <Progress value={transferProgress} className="w-full h-2 mt-2" />
                                )}
                            </div>

                            {/* Received Files Section */} 
                            {receivedFiles.size > 0 && (
                                <div className="border-t pt-4 mt-4 space-y-2">
                                    <Label>Arquivos Recebidos:</Label>
                                    <ul className="space-y-1 max-h-40 overflow-y-auto">
                                        {Array.from(receivedFiles.entries()).map(([fileId, fileInfo]) => (
                                            <li key={fileId} className="flex justify-between items-center text-sm">
                                                <span className="truncate pr-2" title={fileInfo.name}>{fileInfo.name} ({(fileInfo.size / 1024).toFixed(2)} KB)</span>
                                                <Button onClick={() => downloadFile(fileId)} size="sm" variant="outline">
                                                    Download
                                                </Button>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>
            <Toaster />
        </div>
    );
}

export default MainView;

